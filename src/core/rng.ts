/**
 * Deterministic seeded RNG (xoshiro128** style via mulberry32 core).
 * Used everywhere randomness is needed so matches are reproducible from a seed.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // SplitMix32 to expand any seed into a good state
    let x = seed | 0;
    const next = () => {
      x = (x + 0x9e3779b9) | 0;
      let t = x ^ (x >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      return (t = t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
  }

  /** float in [0,1) */
  next(): number {
    const result = (Math.imul(this.s1, 5) >>> 0) as number;
    const r = ((result << 7) | (result >>> 25)) >>> 0;
    const t = (Math.imul(this.s1, 9) >>> 0) as number;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = ((this.s3 << 11) | (this.s3 >>> 21)) >>> 0;
    return (((r ^ t) >>> 0) / 4294967296);
  }

  /** float in [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** integer in [min,max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)] as T;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }

  /** Weighted pick. weights need not sum to 1. Returns index. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Standard normal via Box-Muller. */
  gauss(mean = 0, stddev = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + stddev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  angle(): number {
    return this.next() * Math.PI * 2;
  }
}

/** Hash a string into a 32-bit seed (for named seeds like "neocity-hard"). */
export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Shared gameplay RNG used by combat spread, recoil and AI aim noise so
 * matches are reproducible from a seed. Presentation-only randomness may
 * keep using Math.random.
 */
let gameRng = new Rng(0x00c0ffee);

export function setGameSeed(seed: number): void {
  gameRng = new Rng(seed | 0);
}

export function gameNext(): number {
  return gameRng.next();
}

/** Approximate gaussian from three uniform samples. */
export function gameGauss(): number {
  return (gameRng.next() + gameRng.next() + gameRng.next() - 1.5) / 1.5;
}
