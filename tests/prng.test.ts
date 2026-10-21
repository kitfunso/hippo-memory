import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/base/util/prng.js';

// Outputs recorded from the three copies this module replaced (vector-graph, replay, eval-stats).
const PINNED = [
  [42, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423]],
  [4294967295, [0.8964226141106337, 0.189478256739676, 0.7156526781618595, 0.9440599093213677, 0.8452364315744489]],
] as const;

describe('mulberry32', () => {
  for (const [seed, expected] of PINNED) {
    it(`keeps the first five outputs for seed ${seed}`, () => {
      const next = mulberry32(seed);
      expect([1, 2, 3, 4, 5].map(() => next())).toEqual([...expected]);
    });
  }
});
