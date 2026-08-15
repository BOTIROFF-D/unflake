/**
 * The failure report.
 *
 * The point of a deterministic simulator is not that it finds more bugs — it
 * is that when it finds one it can hand you the exact sequence of events that
 * produced it. So the report is not an afterthought: the timeline below is the
 * artefact the whole design exists to produce.
 */

import { formatMs } from "./kernel.js";
import { formatSeed } from "./prng.js";
import type { TraceEvent } from "./trace.js";
import type { RunResult } from "./types.js";

/**
 * What the report needs to know. Both `check` (random runs) and `explore`
 * (enumerated schedules) produce this shape; `unit` is only there so the
 * header says "run" or "schedule" rather than picking one and being wrong
 * half the time.
 */
export interface FailureReport {
  name: string;
  runs: number;
  failure: RunResult | null;
  failedOnRun: number | null;
  shrank: { from: number; to: number } | null;
  unit?: "run" | "schedule";
}

const useColor =
  typeof process !== "undefined" &&
  !process.env["NO_COLOR"] &&
  process.env["TERM"] !== "dumb" &&
  Boolean(process.stderr?.isTTY);

const paint = (code: string, text: string): string =>
  useColor ? `[${code}m${text}[0m` : text;

const dim = (t: string) => paint("2", t);
const red = (t: string) => paint("31", t);
const bold = (t: string) => paint("1", t);
const cyan = (t: string) => paint("36", t);

const GLYPHS: Record<TraceEvent["kind"], string> = {
  spawn: "▸",
  resume: "·",
  io: "✓",
  fault: "✗",
  note: "»",
  invariant: "!",
  done: "▪",
};

/** Render the event log as an aligned, readable timeline. */
export function formatTimeline(events: readonly TraceEvent[], limit = 60): string {
  const shown = events.length > limit ? events.slice(events.length - limit) : events;
  if (shown.length === 0) return dim("      (no events recorded)");

  const timeWidth = Math.max(...shown.map((e) => formatMs(e.time).length));
  const taskWidth = Math.min(18, Math.max(...shown.map((e) => e.task.length)));

  const lines = shown.map((event) => {
    const time = formatMs(event.time).padStart(timeWidth);
    const task = truncate(event.task, taskWidth).padEnd(taskWidth);
    const glyph = GLYPHS[event.kind];
    const text = event.kind === "fault" || event.kind === "invariant"
      ? red(event.text)
      : event.text;
    return `      ${dim(time)}  ${cyan(task)}  ${glyph} ${text}`;
  });

  if (events.length > shown.length) {
    lines.unshift(dim(`      … ${events.length - shown.length} earlier events omitted`));
  }
  return lines.join("\n");
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** One-line summary of a run, used in progress output. */
export function formatRunSummary(result: RunResult): string {
  const status = result.ok ? "ok" : (result.failure?.kind ?? "failed");
  return `${formatSeed(result.seed)} ${status} · ${result.steps} steps · ${formatMs(result.time)}`;
}

/** The full report printed when a counterexample is found. */
export function formatFailure(report: FailureReport): string {
  const run = report.failure;
  if (!run || !run.failure) return `${report.name}: failed with no recorded failure`;
  const failure = run.failure;
  const unit = report.unit ?? "run";

  const header = [
    "",
    `  ${red("✗")} ${bold(report.name)}`,
    `    ${dim(
      [
        // An enumerated schedule is reproduced by its plan, not its seed, and
        // printing a seed there would suggest a knob that does nothing.
        unit === "run" ? `seed ${formatSeed(run.seed)}` : null,
        report.failedOnRun
          ? unit === "run"
            ? `found on run ${report.failedOnRun} of ${report.runs}`
            : `found on schedule ${report.failedOnRun}`
          : null,
        report.shrank && report.shrank.from !== report.shrank.to
          ? `shrunk ${report.shrank.from} → ${report.shrank.to} steps`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    )}`,
    "",
    `    ${red(failure.message)}`,
    `    ${dim(`detected at step ${failure.step}, t=${formatMs(failure.time)}`)}`,
    "",
    `    ${bold("timeline")}`,
  ];

  const footer = [
    "",
    `    ${bold("reproduce")}`,
    `      ${dim("await")} simulate(body, { plan: ${formatPlan(run.plan)}, planStrict: true })`,
    ...(unit === "run"
      ? [`      ${dim(`or explore the same seed again: { seed: ${formatSeed(run.seed)} }`)}`]
      : []),
    "",
  ];

  return [...header, formatTimeline(run.events), ...footer].join("\n");
}

/**
 * Plans are usually short after shrinking; wrap the ones that are not.
 * Trailing zeros are dropped because `planStrict` supplies zeros past the end
 * of the plan anyway — printing them would only make the repro look scarier
 * than it is.
 */
function formatPlan(plan: readonly number[]): string {
  let end = plan.length;
  while (end > 0 && plan[end - 1] === 0) end--;
  plan = plan.slice(0, end);
  const body = plan.join(", ");
  if (body.length <= 90) return `[${body}]`;
  return `[\n        ${wrap(plan, 24).join(",\n        ")},\n      ]`;
}

function wrap(plan: readonly number[], perLine: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < plan.length; i += perLine) {
    rows.push(plan.slice(i, i + perLine).join(", "));
  }
  return rows;
}
