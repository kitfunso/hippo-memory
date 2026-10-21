import { describe, expect, it } from 'vitest';
import { expectSameOutcomes } from './store-conformance.js';

const side = (score: number, ids = ['a', 'b'], count = 3) => ({
  outcomes: [{ value: { rows: ids.map((id) => ({ id, bm25Score: score })), count } }],
});
type Side = ReturnType<typeof side>;
const compare = (a: Side, b: Side) => () => expectSameOutcomes({ other: a, sqlite: b });

describe('expectSameOutcomes', () => {
  it('agrees when floats differ only in the 16th digit', () => {
    expect(compare(side(-0.7867412117300213), side(-0.7867412117300214))).not.toThrow();
  });

  it('disagrees when floats differ in the 10th digit', () => {
    expect(compare(side(-0.7867412117), side(-0.7867412127))).toThrow();
  });

  it('disagrees on order', () => {
    expect(compare(side(1.5, ['a', 'b']), side(1.5, ['b', 'a']))).toThrow();
  });

  it('disagrees on an integer', () => {
    expect(compare(side(1.5, ['a', 'b'], 3), side(1.5, ['a', 'b'], 4))).toThrow();
  });
});
