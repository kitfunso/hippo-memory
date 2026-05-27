/**
 * J1 anchoring detector — pure module unit tests.
 *
 * Covers:
 * - hashQueryText determinism + token-sort collision behavior
 * - buildSessionKey null-char-delimiter collision safety
 * - detectAnchoring R1, R2, tie precedence, cooldown semantics (including
 *   cross-rule), minDominance threshold, recentRepeatWindow, edge cases
 * - RingBuffer FIFO + cap
 * - getOrCreateRing LRU eviction at session cap
 * - appendRecall + snapshotRing round-trip
 *
 * Pure module, no DB, no global state — runs as fast unit tests.
 *
 * Plan: docs/plans/2026-05-26-j1-anchoring-detector.md.
 */

import { describe, it, expect } from 'vitest';
import {
  hashQueryText,
  buildSessionKey,
  detectAnchoring,
  RingBuffer,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  type RecallHistoryEntry,
  type RecallHistorySnapshot,
} from '../src/recall-history.js';

function entry(queryHash: number, topMemoryId: string | null, anchoredOn?: string): RecallHistoryEntry {
  const e: RecallHistoryEntry = { queryHash, topMemoryId, ts: '2026-05-27T00:00:00Z' };
  if (anchoredOn !== undefined) e.anchoredOn = anchoredOn;
  return e;
}

describe('hashQueryText', () => {
  it('is deterministic across calls', () => {
    expect(hashQueryText('foo bar baz')).toBe(hashQueryText('foo bar baz'));
  });

  it('returns 0 on empty string', () => {
    expect(hashQueryText('')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(hashQueryText('FOO bar')).toBe(hashQueryText('foo BAR'));
  });

  it('collapses whitespace + ignores punctuation', () => {
    expect(hashQueryText('foo,  bar!')).toBe(hashQueryText('foo bar'));
  });

  it('collides on token reorder (textual normalization, v1)', () => {
    // Plan v3: V1 uses sorted-token normalization for "semantic distinctness".
    // Embedding-based distinctness is J1-v2. Locks the v1 design choice.
    expect(hashQueryText('bar foo')).toBe(hashQueryText('foo bar'));
  });

  it('distinguishes different token sets', () => {
    expect(hashQueryText('foo bar')).not.toBe(hashQueryText('foo baz'));
  });
});

describe('buildSessionKey', () => {
  it('uses null-char delimiter to prevent colon-collision', () => {
    // tenantId 'api_key:hk_x' could collide with another tenant 'api' + session 'key:hk_x'
    // if delimiter were ':'. NUL ensures uniqueness.
    expect(buildSessionKey('api_key:hk_x', 'sess1')).toBe('api_key:hk_x\x00sess1');
    expect(buildSessionKey('api_key:hk_x', 'sess1')).not.toBe(buildSessionKey('api_key', 'hk_x:sess1'));
  });
});

describe('detectAnchoring — R1 query_repeat', () => {
  it('fires when query+top repeats within recentRepeatWindow', () => {
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_b'),
    ];
    const hint = detectAnchoring(hist, 100, 'mem_a');
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('query_repeat');
    expect(hint!.memoryId).toBe('mem_a');
  });

  it('does NOT fire when query matches but top is different', () => {
    const hist: RecallHistorySnapshot = [entry(100, 'mem_a')];
    expect(detectAnchoring(hist, 100, 'mem_b')).toBeNull();
  });

  it('does NOT fire when query repeat is outside recentRepeatWindow', () => {
    // Default window = 5. Put the matching entry 6 back.
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'), // [0] — outside window=5 when slice(-5) runs on 6+ entries
      entry(201, 'x'), entry(202, 'x'), entry(203, 'x'), entry(204, 'x'), entry(205, 'x'),
    ];
    expect(detectAnchoring(hist, 100, 'mem_a')).toBeNull();
  });

  it('does NOT fire when currentTopMemoryId is null', () => {
    const hist: RecallHistorySnapshot = [entry(100, null)];
    expect(detectAnchoring(hist, 100, null)).toBeNull();
  });
});

describe('detectAnchoring — R2 memory_dominance', () => {
  it('fires when same memory wins >=3 distinct queries (including current)', () => {
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_a'),
    ];
    const hint = detectAnchoring(hist, 300, 'mem_a');
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('memory_dominance');
    expect(hint!.memoryId).toBe('mem_a');
    expect(hint!.queryCount).toBe(3);
  });

  it('does NOT fire below minDominance threshold', () => {
    const hist: RecallHistorySnapshot = [entry(100, 'mem_a')];
    expect(detectAnchoring(hist, 200, 'mem_a')).toBeNull();
  });

  it('counts only DISTINCT queryHashes (same query repeated does not inflate)', () => {
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(100, 'mem_a'), // duplicate query — only counted once
    ];
    // Current is also queryHash=100 → still only 1 distinct queryHash → no R2
    expect(detectAnchoring(hist, 100, 'mem_a')?.reason).not.toBe('memory_dominance');
  });
});

describe('detectAnchoring — tie precedence + cooldown', () => {
  it('R2 wins on tie (both R1 and R2 conditions met → returns R2)', () => {
    // 3 distinct queryHashes returning mem_a (100, 200, 300). Current is
    // queryHash 100 + top mem_a → R1 fires (query 100 in window).
    // R2 also fires (distinct queries returning mem_a = {100, 200, 300} = 3).
    // Spec: R2 wins.
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_a'),
      entry(300, 'mem_a'),
    ];
    const hint = detectAnchoring(hist, 100, 'mem_a');
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('memory_dominance');
  });

  it('cooldown suppresses re-fire on same memory within window', () => {
    // History has R2 fire recorded as anchoredOn=mem_a in last entry.
    // Subsequent recall on mem_a should be suppressed by cooldown.
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_a'),
      entry(300, 'mem_a', /*anchoredOn=*/ 'mem_a'), // R2 fired here
    ];
    // New recall, same top mem_a — cooldown should suppress.
    expect(detectAnchoring(hist, 400, 'mem_a')).toBeNull();
  });

  it('cooldown is PER-MEMORY: R1 can fire on different memory after R2 cooldown', () => {
    // R2 fired on mem_a (cooldown engaged for mem_a). Now next recall has
    // different top mem_b + repeated query → R1 fires on mem_b (different
    // memory, not in cooldown). Locks the cross-rule cooldown boundary.
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_a'),
      entry(300, 'mem_a', /*anchoredOn=*/ 'mem_a'), // R2 fired on mem_a
      entry(400, 'mem_b'), // different top, no anchoredOn
    ];
    // Current recall: queryHash 400 (same as last entry's queryHash), top mem_b
    // → R1 should fire on mem_b (cooldown is for mem_a, not mem_b).
    const hint = detectAnchoring(hist, 400, 'mem_b');
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('query_repeat');
    expect(hint!.memoryId).toBe('mem_b');
  });
});

describe('RingBuffer + helpers', () => {
  it('FIFO appends with MAX_HISTORY cap', () => {
    const ring = new RingBuffer();
    for (let i = 0; i < 15; i++) {
      appendRecall(ring, i, `mem_${i}`);
    }
    // Cap is 10 — first 5 should be evicted.
    expect(ring.size()).toBe(10);
    const snap = snapshotRing(ring);
    expect(snap[0].queryHash).toBe(5); // first surviving = index 5
    expect(snap[9].queryHash).toBe(14);
  });

  it('getOrCreateRing returns same instance on repeated key', () => {
    const map = new Map<string, RingBuffer>();
    const r1 = getOrCreateRing(map, 'k1');
    const r2 = getOrCreateRing(map, 'k1');
    expect(r1).toBe(r2);
  });

  it('LRU evicts oldest key when session cap exceeded', () => {
    const map = new Map<string, RingBuffer>();
    const cap = 3;
    getOrCreateRing(map, 'a', cap);
    getOrCreateRing(map, 'b', cap);
    getOrCreateRing(map, 'c', cap);
    expect(Array.from(map.keys())).toEqual(['a', 'b', 'c']);
    getOrCreateRing(map, 'd', cap);
    // 'a' should be evicted (oldest); 'b', 'c', 'd' remain.
    expect(Array.from(map.keys())).toEqual(['b', 'c', 'd']);
  });

  it('LRU touches existing key to back of iteration order', () => {
    const map = new Map<string, RingBuffer>();
    const cap = 3;
    getOrCreateRing(map, 'a', cap);
    getOrCreateRing(map, 'b', cap);
    getOrCreateRing(map, 'c', cap);
    getOrCreateRing(map, 'a', cap); // touch — moves to back
    expect(Array.from(map.keys())).toEqual(['b', 'c', 'a']);
    getOrCreateRing(map, 'd', cap);
    expect(Array.from(map.keys())).toEqual(['c', 'a', 'd']); // b evicted, not a
  });

  it('appendRecall stores anchoredOn when provided', () => {
    const ring = new RingBuffer();
    appendRecall(ring, 100, 'mem_a', 'mem_b');
    const snap = snapshotRing(ring);
    expect(snap[0].anchoredOn).toBe('mem_b');
  });
});
