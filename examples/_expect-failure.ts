import { UnflakeFailure } from "../src/index.js";

/**
 * Await a `check` that is supposed to fail, and hand back the report.
 *
 * Worth a helper because the failure mode it guards against is the quiet one:
 * if the bug ever stops being found, the test should say "the property held"
 * rather than trip over an unexpected resolution somewhere further down.
 */
export async function expectFailure(promise: Promise<unknown>): Promise<UnflakeFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnflakeFailure) return error;
    throw error;
  }
  throw new Error("expected check() to find a counterexample, but the property held");
}
