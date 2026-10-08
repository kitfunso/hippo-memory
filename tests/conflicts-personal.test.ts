// E10 lane A: a personal row is never paired with a row outside its own scope, since the pair names both ids.
import { describe, it, expect } from 'vitest';
import type { MemoryEntry } from '../src/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { detectConflicts } from '../src/consolidate/conflicts.js';

const now = new Date();
const rule = (text: string, id: string, scope: string | null): MemoryEntry => ({
  ...createMemory(text, { scope }), id, origin_project: 'proj', created: now.toISOString(), last_retrieved: now.toISOString(),
});
const ALICE = 'personal:private:alice';

describe('conflicts and personal scopes (E10 lane A)', () => {
  it('a personal row against a team row gives no pair, while two team rows do', () => {
    const always = rule('always alpha beta gamma', 'a', null);
    const never = rule('never alpha beta gamma zeta', 'b', null);
    expect(detectConflicts([always, never], now)).toHaveLength(1);
    expect(detectConflicts([{ ...always, scope: ALICE }, never], now)).toEqual([]);
    expect(detectConflicts([always, { ...never, scope: ALICE }], now)).toEqual([]);
  });

  it('two rows in one personal scope still pair', () => {
    const pair = detectConflicts([rule('always alpha beta gamma', 'a', ALICE), rule('never alpha beta gamma zeta', 'b', ALICE)], now);
    expect(pair.map((p) => [p.memory_a_id, p.memory_b_id])).toEqual([['a', 'b']]);
  });

  it('two owners, or a case variant of one owner, never pair', () => {
    const mine = rule('always alpha beta gamma', 'a', ALICE);
    expect(detectConflicts([mine, rule('never alpha beta gamma zeta', 'b', 'personal:private:bob')], now)).toEqual([]);
    expect(detectConflicts([mine, rule('never alpha beta gamma zeta', 'b', 'Personal:private:alice')], now)).toEqual([]);
  });
});
