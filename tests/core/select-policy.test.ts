// The budget policy of a context block and of session-rules, on plain rows with no store.
import { describe, expect, it } from 'vitest';
import { type HippoConfig, DEFAULT_CONFIG } from '../../src/base/config/config.js';
import {
  newestWithin,
  pinsWithinCap,
  promptRecallShareOf,
  sessionRulesBudgetOf,
  type PricedRow,
} from '../../src/domain/context/select-policy.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';

const DAY_MS = 86_400_000;
const FIRST_MS = Date.UTC(2026, 0, 1);

/** A priced row; a higher `day` is newer. */
function row(id: string, day: number, score: number, tokens: number): PricedRow {
  const entry = { ...createMemory(`row ${id}`), id, created: new Date(FIRST_MS + day * DAY_MS).toISOString() };
  return { entry, score, tokens };
}

const idsOf = (rows: readonly PricedRow[]): string[] => rows.map((r) => r.entry.id);

describe('pinsWithinCap', () => {
  it('keeps the strongest pins when not all fit', () => {
    const ranked = [row('weak', 3, 0.5, 10), row('strong', 1, 0.9, 10), row('mid', 2, 0.7, 10)];
    expect(idsOf(pinsWithinCap(ranked, 20))).toEqual(['strong', 'mid']);
  });

  it('keeps the newest of equal scores', () => {
    const ranked = [row('old', 1, 1, 10), row('new', 3, 1, 10), row('mid', 2, 1, 10)];
    expect(idsOf(pinsWithinCap(ranked, 20))).toEqual(['new', 'mid']);
  });

  it('skips a pin that does not fit and keeps the smaller ones behind it', () => {
    const ranked = [row('first', 3, 1, 10), row('big', 2, 1, 50), row('small', 1, 1, 10)];
    expect(idsOf(pinsWithinCap(ranked, 25))).toEqual(['first', 'small']);
  });

  it('keeps each id once, the stronger copy', () => {
    const ranked = [row('a', 1, 0.5, 10), row('a', 1, 0.9, 10), row('b', 2, 0.4, 10)];
    const kept = pinsWithinCap(ranked, 100);
    expect(idsOf(kept)).toEqual(['a', 'b']);
    expect(kept[0]).toBe(ranked[1]);
  });

  it('returns the kept rows in the order it was given', () => {
    const ranked = [row('c', 1, 0.3, 10), row('a', 3, 0.9, 10), row('b', 2, 0.6, 10)];
    expect(idsOf(pinsWithinCap(ranked, 30))).toEqual(['c', 'a', 'b']);
    expect(idsOf(pinsWithinCap(ranked, 20))).toEqual(['a', 'b']);
  });

  it('hands each dropped row to onOverCap', () => {
    const ranked = [row('a', 3, 0.9, 10), row('big', 2, 0.8, 90), row('b', 1, 0.7, 10), row('c', 0, 0.6, 10)];
    const dropped: string[] = [];
    pinsWithinCap(ranked, 20, (r) => dropped.push(r.entry.id));
    expect(dropped).toEqual(['big', 'c']);
  });

  it('keeps nothing under a cap of 0', () => {
    expect(pinsWithinCap([row('a', 1, 1, 10)], 0)).toEqual([]);
  });
});

describe('newestWithin', () => {
  const rule = (id: string, day: number, tokens: number) => ({ id, created: row(id, day, 1, tokens).entry.created, tokens });
  const price = (r: { tokens: number }): number => r.tokens;
  const idList = (rows: ReadonlyArray<{ id: string }>): string[] => rows.map((r) => r.id);

  it('keeps the newest rows that fit', () => {
    const rows = [rule('old', 1, 10), rule('mid', 2, 10), rule('new', 3, 10)];
    expect(idList(newestWithin(rows, 20, price))).toEqual(['mid', 'new']);
  });

  it('keeps the later row of equal age', () => {
    const rows = [rule('first', 1, 10), rule('second', 1, 10)];
    expect(idList(newestWithin(rows, 10, price))).toEqual(['second']);
  });

  it('skips a row that does not fit and keeps the older ones behind it', () => {
    const rows = [rule('old', 1, 10), rule('big', 2, 50), rule('new', 3, 10)];
    expect(idList(newestWithin(rows, 25, price))).toEqual(['old', 'new']);
  });

  it('returns the kept rows in the order it was given', () => {
    const rows = [rule('a', 1, 10), rule('b', 2, 10), rule('c', 3, 10)];
    expect(idList(newestWithin(rows, 100, price))).toEqual(['a', 'b', 'c']);
  });

  it('keeps nothing under a budget of 0', () => {
    expect(newestWithin([rule('a', 1, 10)], 0, price)).toEqual([]);
  });
});

describe('promptRecallShareOf and sessionRulesBudgetOf', () => {
  const withKeys = (keys: Partial<HippoConfig['pinnedInject']>): HippoConfig['pinnedInject'] => ({
    ...DEFAULT_CONFIG.pinnedInject,
    ...keys,
  });
  // A config built in code before these keys existed has neither.
  const { promptRecallShare: _share, sessionRulesBudget: _budget, ...withoutKeys } = DEFAULT_CONFIG.pinnedInject;

  it('reads a missing share key and NaN as 0.25', () => {
    expect(promptRecallShareOf(withoutKeys)).toBe(0.25);
    expect(promptRecallShareOf(withKeys({ promptRecallShare: Number.NaN }))).toBe(0.25);
  });

  it('reads a share above 1 as 1 and a negative share as 0.25', () => {
    expect(promptRecallShareOf(withKeys({ promptRecallShare: 2 }))).toBe(1);
    expect(promptRecallShareOf(withKeys({ promptRecallShare: -1 }))).toBe(0.25);
  });

  it('reads a share of 0 as 0, so prompt recall keeps nothing', () => {
    expect(promptRecallShareOf(withKeys({ promptRecallShare: 0 }))).toBe(0);
  });

  it('reads a missing session-rules budget, NaN and 0 as 2000', () => {
    expect(sessionRulesBudgetOf(withoutKeys)).toBe(2000);
    expect(sessionRulesBudgetOf(withKeys({ sessionRulesBudget: Number.NaN }))).toBe(2000);
    expect(sessionRulesBudgetOf(withKeys({ sessionRulesBudget: 0 }))).toBe(2000);
    expect(sessionRulesBudgetOf(withKeys({ sessionRulesBudget: 300 }))).toBe(300);
  });
});
