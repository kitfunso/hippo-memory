// The store-side reads a write uses give the answers the loaded tenant rows gave: schema fit, and the newest-rows window.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { makeRoot } from './_helpers/make-root.js';
import { openStore } from '../src/store/open.js';
import { writeEntryOn } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadNewestEntries, schemaFitInStore } from '../src/store/candidates.js';
import { closeHippoDb } from '../src/db.js';
import { computeSchemaFit, createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/memory.js';

const TENANT = 'default';
const WORDS = ['cache', 'refresh', 'pipeline', 'İstanbul', 'KELVINK', 'café', 'deploy', 'friday', 'rota', 'api', 'to', 'sharpe', 'backtest', 'zephyrine'] as const;
const TAGS = ['error', 'data-pipeline', 'quant', 'topic:cache', 'Rule', 'rule'] as const;
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Seeded generator, so every run draws the same fixtures. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawn<T>(from: readonly T[], count: number, random: () => number): T[] {
  return Array.from({ length: count }, () => from[Math.floor(random() * from.length)]);
}

function storeWith(entries: readonly MemoryEntry[]): string {
  const root = makeRoot('schema-fit-store');
  roots.push(root);
  const db = openStore(root);
  try {
    for (const entry of entries) writeEntryOn(db, root, entry);
  } finally {
    closeHippoDb(db);
  }
  return root;
}

function randomRows(count: number, random: () => number, tenantId: string): MemoryEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    ...createMemory(`${drawn(WORDS, 2 + Math.floor(random() * 6), random).join(' ')} ${i}`, {
      tags: drawn(TAGS, Math.floor(random() * 4), random),
      tenantId,
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    }),
    // Shared timestamps make the id the tie-break, as it is in a busy store.
    created: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(i / 3))).toISOString(),
  }));
}

/** Schema fit as it was computed from every loaded row, with no early stop. */
function fitOverLoadedRows(content: string, tags: readonly string[], existing: readonly MemoryEntry[]): number {
  const tokens = (text: string): Set<string> => new Set(text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3));
  if (existing.length === 0) return 0.5;
  const tagFreq = new Map<string, number>();
  for (const entry of existing) for (const tag of entry.tags) tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
  if (tags.length === 0 && tagFreq.size === 0) return 0.5;
  const N = existing.length;
  let weightedOverlap = 0;
  let totalWeight = 0;
  for (const tag of tags) {
    const freq = tagFreq.get(tag) ?? 0;
    if (freq > 0) weightedOverlap += Math.log(N / freq) + 1;
    totalWeight += Math.log(N + 1) + 1;
  }
  const tagScore = totalWeight > 0 ? Math.min(1, (weightedOverlap / totalWeight) * 2) : 0;
  const newTokens = tokens(content);
  if (newTokens.size === 0) return Math.min(1, Math.max(0, tagScore));
  let contentMatches = 0;
  for (const entry of existing) {
    const entryTokens = tokens(entry.content);
    let shared = 0;
    for (const token of newTokens) if (entryTokens.has(token)) shared++;
    if (shared / Math.max(newTokens.size, 1) > 0.2) contentMatches++;
  }
  return Math.min(1, Math.max(0, 0.6 * tagScore + 0.4 * Math.min(1, contentMatches / Math.max(5, N * 0.1))));
}

describe('schemaFitInStore', () => {
  it('equals the fit over every loaded row, for stores below and above the size where the match cap grows', () => {
    const random = seededRandom(20261);
    let stoppedEarly = 0;
    for (const size of [0, 1, 7, 60, 150]) {
      // Another tenant's rows share the store and must not move the score.
      const root = storeWith([...randomRows(size, random, TENANT), ...randomRows(9, random, 'other-tenant')]);
      const loaded = loadAllEntries(root, TENANT);
      expect(loaded).toHaveLength(size);
      const probes: Array<[string, string[]]> = [
        ['', []],
        ['to api', ['error']],
        ['cache refresh pipeline', ['error', 'error', 'unseen']],
        ['İstanbul café KELVINK', []],
        ...Array.from({ length: 12 }, (): [string, string[]] => [drawn(WORDS, 1 + Math.floor(random() * 8), random).join(', '), drawn(TAGS, Math.floor(random() * 3), random)]),
      ];
      for (const [content, tags] of probes) {
        const expected = fitOverLoadedRows(content, tags, loaded);
        expect(schemaFitInStore(root, TENANT, content, tags)).toBe(expected);
        expect(computeSchemaFit(content, tags, loaded)).toBe(expected);
        if (expected === 1 || (tags.length === 0 && expected === 0.4)) stoppedEarly++;
      }
    }
    // Some probes must reach the match cap, or the early stop was never exercised.
    expect(stoppedEarly).toBeGreaterThan(0);
  });

  it('counts a tag once per row that carries it, repeats included', () => {
    const rows = [['rule', 'rule'], ['rule'], ['other'], []].map((tags, i) => createMemory(`entry ${i} about gardening`, { tags, baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    const root = storeWith(rows);
    const loaded = loadAllEntries(root, TENANT);
    for (const tags of [['rule'], ['other'], ['rule', 'other', 'absent']]) {
      expect(schemaFitInStore(root, TENANT, 'nothing shared here', tags)).toBe(fitOverLoadedRows('nothing shared here', tags, loaded));
    }
  });
});

describe('loadNewestEntries', () => {
  it('returns the tail of the full list, in the same order, for a window below, at and above the row count', () => {
    const random = seededRandom(7);
    const root = storeWith([...randomRows(25, random, TENANT), ...randomRows(6, random, 'other-tenant')]);
    const all = loadAllEntries(root, TENANT);
    for (const window of [1, 3, 24, 25, 40]) {
      expect(loadNewestEntries(root, TENANT, window)).toEqual(all.slice(-window));
    }
  });
});
