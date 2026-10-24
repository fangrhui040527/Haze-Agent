/**
 * Seeded random numbers (mulberry32). The same seed always produces the same sequence,
 * so demo data can be regenerated exactly.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  float(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(list: readonly T[]): T;
  /** Pick using relative weights, e.g. [['a', 3], ['b', 1]]. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  shuffle<T>(list: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    chance: (probability) => next() < probability,
    pick: (list) => {
      if (list.length === 0) throw new Error('pick() from an empty list');
      return list[Math.floor(next() * list.length)];
    },
    weighted: (entries) => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      let roll = next() * total;
      for (const [value, weight] of entries) {
        roll -= weight;
        if (roll < 0) return value;
      }
      const last = entries[entries.length - 1];
      if (!last) throw new Error('weighted() with no entries');
      return last[0];
    },
    shuffle: (list) => {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    },
  };
  return rng;
}
