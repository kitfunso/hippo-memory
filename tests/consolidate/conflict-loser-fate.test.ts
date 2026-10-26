// The domain decides each conflict loser's fate, with every number in it, so a store only applies what it is given.
import { describe, expect, it } from 'vitest';
import { BadRequestError } from '../../src/base/errors/api-errors.js';
import { conflictLoserFate } from '../../src/domain/consolidate/conflicts.js';

const LOSER = { id: 'mem_loser', scope: null };

describe('conflictLoserFate', () => {
  it('weakens by default: half the half-life, never under one day', () => {
    expect(conflictLoserFate({}, LOSER, null)).toEqual({ kind: 'weaken', halfLifeFactor: 0.5, minHalfLifeDays: 1 });
  });

  it('removes the loser on forget', () => {
    expect(conflictLoserFate({ forget: true }, LOSER, null)).toEqual({ kind: 'remove' });
  });

  it('rejects the value on rejectLoser, whatever forget says, sweeping only the scope the caller may touch', () => {
    const own = 'personal:private:alice';
    expect(conflictLoserFate({ rejectLoser: true }, LOSER, own)).toEqual({ kind: 'reject', ownScope: own });
    expect(conflictLoserFate({ rejectLoser: true, forget: false }, LOSER, null)).toEqual({
      kind: 'reject',
      ownScope: null,
    });
  });

  it("refuses to reject a personal row's value, since the tombstone reaches the whole tenant", () => {
    const personal = { id: 'mem_p', scope: 'personal:private:bob' };
    expect(() => conflictLoserFate({ rejectLoser: true }, personal, null)).toThrow(BadRequestError);
    expect(conflictLoserFate({ forget: true }, personal, null)).toEqual({ kind: 'remove' });
  });
});
