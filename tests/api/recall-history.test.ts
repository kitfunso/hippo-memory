import { describe, it, expect } from 'vitest';
import {
  buildSessionKey,
  RingBuffer,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
} from '../../src/api/recall/session-rings.js';
import {
  hashQueryText,
  detectAnchoring,
  type RecallHistoryEntry,
  type RecallHistorySnapshot,
} from '../../src/api/recall/anchoring.js';
import { evalNow } from '../../src/infra/eval-switches.js';

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
    expect(hashQueryText('bar foo')).toBe(hashQueryText('foo bar'));
  });

  it('distinguishes different token sets', () => {
    expect(hashQueryText('foo bar')).not.toBe(hashQueryText('foo baz'));
  });

  it('preserves Unicode letters across scripts (CJK, Cyrillic, Arabic)', () => {
    const jp = hashQueryText('テスト 環境');
    const cn = hashQueryText('测试 环境');
    const ru = hashQueryText('тест окружение');
    const ar = hashQueryText('اختبار بيئة');
    expect(jp).not.toBe(0);
    expect(cn).not.toBe(0);
    expect(ru).not.toBe(0);
    expect(ar).not.toBe(0);
    expect(jp).not.toBe(cn);
    expect(jp).not.toBe(ru);
    expect(ru).not.toBe(ar);
  });

  it('preserves accented Latin (composed forms)', () => {
    expect(hashQueryText('café')).not.toBe(hashQueryText('cafe'));
  });

  it('collapses queries differing only by 1-2 char filler tokens', () => {
    expect(hashQueryText('a login bug')).toBe(hashQueryText('login bug'));
    expect(hashQueryText('is login bug')).toBe(hashQueryText('login bug'));
    expect(hashQueryText('is a login bug')).toBe(hashQueryText('login bug'));
    expect(hashQueryText('the login bug')).not.toBe(hashQueryText('login bug'));
  });

  it('does NOT collapse all-short-token queries to hash 0 (CJK + acronyms)', () => {
    const cn = hashQueryText('测试 环境');
    const ai = hashQueryText('AI UI');
    const jp = hashQueryText('テスト');
    expect(cn).not.toBe(0);
    expect(ai).not.toBe(0);
    expect(jp).not.toBe(0);
    expect(cn).not.toBe(ai);
    expect(hashQueryText('测试')).not.toBe(hashQueryText('环境'));
    expect(hashQueryText('AI')).not.toBe(hashQueryText('UI'));
  });
});

describe('buildSessionKey', () => {
  it('uses null-char delimiter to prevent colon-collision', () => {
    expect(buildSessionKey('api_key:hk_x', 'sess1')).toBe('api_key:hk_x\x00sess1');
    expect(buildSessionKey('api_key:hk_x', 'sess1')).not.toBe(buildSessionKey('api_key', 'hk_x:sess1'));
  });
});

describe('detectAnchoring — R1 query_repeat', () => {
  it('fires when query+top repeats within recentRepeatWindow', () => {
    const hist: RecallHistorySnapshot = [entry(100, 'mem_a'), entry(200, 'mem_b')];
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
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'), // [0] — outside window=5 when slice(-5) runs on 6+ entries
      entry(201, 'x'),
      entry(202, 'x'),
      entry(203, 'x'),
      entry(204, 'x'),
      entry(205, 'x'),
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
    const hist: RecallHistorySnapshot = [entry(100, 'mem_a'), entry(200, 'mem_a')];
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
    expect(detectAnchoring(hist, 100, 'mem_a')?.reason).not.toBe('memory_dominance');
  });
});

describe('detectAnchoring — tie precedence + cooldown', () => {
  it('R2 wins on tie (both R1 and R2 conditions met → returns R2)', () => {
    const hist: RecallHistorySnapshot = [entry(100, 'mem_a'), entry(200, 'mem_a'), entry(300, 'mem_a')];
    const hint = detectAnchoring(hist, 100, 'mem_a');
    expect(hint).not.toBeNull();
    expect(hint!.reason).toBe('memory_dominance');
  });

  it('cooldown suppresses re-fire on same memory within window', () => {
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_a'),
      entry(300, 'mem_a', /*anchoredOn=*/ 'mem_a'), // R2 fired here
    ];
    expect(detectAnchoring(hist, 400, 'mem_a')).toBeNull();
  });

  it('cooldown is PER-MEMORY: R1 can fire on different memory after R2 cooldown', () => {
    const hist: RecallHistorySnapshot = [
      entry(100, 'mem_a'),
      entry(200, 'mem_a'),
      entry(300, 'mem_a', /*anchoredOn=*/ 'mem_a'), // R2 fired on mem_a
      entry(400, 'mem_b'), // different top, no anchoredOn
    ];
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
      appendRecall({ ring, queryHash: i, topMemoryId: `mem_${i}`, now: evalNow() });
    }
    expect(ring.size()).toBe(10);
    const snap = snapshotRing(ring);
    expect(snap[0].queryHash).toBe(5);
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
    expect(Array.from(map.keys())).toEqual(['b', 'c', 'd']);
  });

  it('LRU touches existing key to back of iteration order', () => {
    const map = new Map<string, RingBuffer>();
    const cap = 3;
    getOrCreateRing(map, 'a', cap);
    getOrCreateRing(map, 'b', cap);
    getOrCreateRing(map, 'c', cap);
    getOrCreateRing(map, 'a', cap);
    expect(Array.from(map.keys())).toEqual(['b', 'c', 'a']);
    getOrCreateRing(map, 'd', cap);
    expect(Array.from(map.keys())).toEqual(['c', 'a', 'd']);
  });

  it('appendRecall stores anchoredOn when provided', () => {
    const ring = new RingBuffer();
    appendRecall({ ring, queryHash: 100, topMemoryId: 'mem_a', now: evalNow(), anchoredOn: 'mem_b' });
    const snap = snapshotRing(ring);
    expect(snap[0].anchoredOn).toBe('mem_b');
  });
});
