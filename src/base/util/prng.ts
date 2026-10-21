// Mulberry32: a small seeded PRNG, same seed and same stream on every platform, with no dependency.

export interface Mulberry32Step {
  state: number;
  value: number;
}

/** Advances a 32-bit mulberry32 state and returns the float in [0, 1) drawn from the new state. */
export function stepMulberry32(state: number): Mulberry32Step {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { state: next, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** A generator of floats in [0, 1); the stream is fixed by the seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    const step = stepMulberry32(state);
    state = step.state;
    return step.value;
  };
}
