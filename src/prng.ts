/**
 * Seeded pseudo-random source.
 *
 * Everything nondeterministic in a simulation ultimately comes from here, so
 * this file has one hard requirement: the same seed must produce the same
 * sequence on every machine, every Node version, forever. That rules out
 * anything touching floating-point accumulation or platform intrinsics —
 * `sfc32` is pure 32-bit integer arithmetic, which JavaScript specifies
 * exactly, and it is what the determinism self-check in the test suite pins.
 */

/** A seed is either a uint32 or a string that hashes to one. */
export type Seed = number | string;

/** cyrb128 — string → four well-mixed uint32 words for sfc32's state. */
function hashString(str: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  return [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];
}

/** Normalise any accepted seed form to a uint32. */
export function normalizeSeed(seed: Seed): number {
  if (typeof seed === "number") {
    if (!Number.isFinite(seed)) throw new TypeError(`seed must be finite, got ${seed}`);
    return seed >>> 0;
  }
  return hashString(seed)[0];
}

/** Render a seed the way unflake prints it, so it can be pasted back verbatim. */
export function formatSeed(seed: number): string {
  return `0x${(seed >>> 0).toString(16).padStart(8, "0")}`;
}

/** Parse the printed form (or a plain decimal) back into a uint32. */
export function parseSeed(text: string): number {
  const trimmed = text.trim();
  const value = trimmed.startsWith("0x") || trimmed.startsWith("0X")
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value)) throw new TypeError(`not a seed: ${text}`);
  return value >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: Seed) {
    const s = typeof seed === "string" ? hashString(seed) : hashString(`unflake:${seed >>> 0}`);
    this.a = s[0];
    this.b = s[1];
    this.c = s[2];
    this.d = s[3];
    // Discard the first few outputs so nearby seeds decorrelate. Consecutive
    // run seeds (n, n+1, n+2 …) are the common case in `check`, and without
    // this warm-up their early draws are visibly similar.
    for (let i = 0; i < 12; i++) this.uint32();
  }

  /** sfc32 — small, fast, passes PractRand well past any budget we use. */
  uint32(): number {
    this.a |= 0;
    this.b |= 0;
    this.c |= 0;
    this.d |= 0;
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.uint32() / 4294967296;
  }

  /**
   * Uniform integer in [0, bound). Uses rejection sampling rather than a
   * modulo so the distribution stays exactly uniform — biased draws would
   * make rare interleavings even rarer, which is the opposite of the point.
   */
  below(bound: number): number {
    if (bound <= 1) return 0;
    const limit = Math.floor(4294967296 / bound) * bound;
    let x = this.uint32();
    while (x >= limit) x = this.uint32();
    return x % bound;
  }

  /** Uniform integer in [lo, hi], inclusive. */
  between(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + this.below(hi - lo + 1);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.float() < p;
  }
}
