import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { retrieve } from '../../src/api/index.js';
import { estimateTokens } from '../../src/base/util/token-text.js';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { insertEntityAt, insertRelationAt } from '../_helpers/graph-seed.js';
import { graphExpandRecall } from '../../src/domain/graph/recall.js';
import { compareEntryIdentity, type EntryIdentity } from '../../src/base/rank/compare.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore, apiCtx } = sessionPerTest();

describe('api.ts:833 DAG substitution ordering', () => {
  function ctxFor(root: string, tenantId: string = 'default'): FullContext {
    return apiCtx(root, tenantId, { subject: 'test:tiebreak', role: 'admin' });
  }
  function makeLeaf(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
    return createMemory(text, {
      layer: Layer.Buffer,
      tags: opts.tags ?? [],
      confidence: 'observed',
      dagLevel: opts.dagLevel ?? 0,
      dagParentId: opts.dagParentId ?? undefined,
      tenantId: opts.tenantId ?? 'default',
      kind: opts.kind ?? 'distilled',
    });
  }
  function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
    return createMemory(text, {
      layer: Layer.Semantic,
      tags: opts.tags ?? ['dag-summary'],
      confidence: 'inferred',
      dagLevel: 2,
      tenantId: opts.tenantId ?? 'default',
    });
  }

  let root: string;
  beforeEach(() => {
    root = makeRoot('dag-tiebreak');
  });

  it('primary wins: the summary with MORE overflowing children is substituted, not the one with fewer', async () => {
    const summaryA = makeSummary('topic A summary', { tags: ['dag-summary', 'topic:a'] });
    writeEntry(root, summaryA);
    for (let i = 0; i < 3; i++) {
      writeEntry(
        root,
        makeLeaf(`alpha zulu topic event a-${i}`, {
          dagLevel: 1,
          dagParentId: summaryA.id,
        }),
      );
    }

    const summaryB = makeSummary('topic B summary', { tags: ['dag-summary', 'topic:b'] });
    writeEntry(root, summaryB);
    for (let i = 0; i < 6; i++) {
      writeEntry(
        root,
        makeLeaf(`alpha zulu topic event b-${i}`, {
          dagLevel: 1,
          dagParentId: summaryB.id,
        }),
      );
    }

    const r = await retrieve(ctxFor(root), { query: 'alpha zulu topic event', window: { limit: 1 } });
    const summaries = r.results.filter((it) => it.isSummary);
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe(summaryB.id);
  });

  it('tail decides: equal overflow counts fall back to compareEntryIdentity (content ascending)', () => {
    const parentA: EntryIdentity = { id: 'parent-zzz', content: 'zzz summary of topic zzz' };
    const parentB: EntryIdentity = { id: 'parent-aaa', content: 'aaa summary of topic aaa' };
    const overflowByParent = new Map<string, number>([
      [parentA.id, 2],
      [parentB.id, 2], // tied overflow count with parentA
    ]);
    const eligibleParents = [parentA, parentB];
    eligibleParents.sort((a, b) => {
      const ac = overflowByParent.get(a.id) ?? 0;
      const bc = overflowByParent.get(b.id) ?? 0;
      return bc !== ac ? bc - ac : compareEntryIdentity(a, b);
    });
    expect(eligibleParents.map((p) => p.id)).toEqual([parentB.id, parentA.id]);
  });
});

describe('cli.ts:1167 --evc-adaptive ordering', () => {
  interface OnTopicRow {
    entry: { created: string; content: string; id: string };
    score: number;
  }
  function sortOnTopic(rows: OnTopicRow[]): OnTopicRow[] {
    return [...rows].sort((a, b) => {
      const ta = new Date(a.entry.created).getTime();
      const tb = new Date(b.entry.created).getTime();
      return tb !== ta ? tb - ta : compareEntryIdentity(a.entry, b.entry);
    });
  }

  it('primary wins: recency desc decides regardless of score or content', () => {
    const older: OnTopicRow = {
      entry: { created: '2020-01-01T00:00:00.000Z', content: 'zzz older but higher score', id: 'id-older' },
      score: 9,
    };
    const newer: OnTopicRow = {
      entry: { created: '2026-01-01T00:00:00.000Z', content: 'aaa newer but lower score', id: 'id-newer' },
      score: 1,
    };
    expect(sortOnTopic([older, newer]).map((r) => r.entry.id)).toEqual([newer.entry.id, older.entry.id]);
    expect(sortOnTopic([newer, older]).map((r) => r.entry.id)).toEqual([newer.entry.id, older.entry.id]);
  });

  it('tail decides: entries created at the exact same timestamp fall back to compareEntryIdentity (content ascending)', () => {
    const tiedTimestamp = '2026-03-01T00:00:00.000Z';
    const higherScore: OnTopicRow = {
      entry: { created: tiedTimestamp, content: 'zebra higher pre-evc score', id: 'id-z' },
      score: 9,
    };
    const lowerScore: OnTopicRow = {
      entry: { created: tiedTimestamp, content: 'apple lower pre-evc score', id: 'id-a' },
      score: 1,
    };
    expect(sortOnTopic([higherScore, lowerScore]).map((r) => r.entry.id)).toEqual([
      lowerScore.entry.id,
      higherScore.entry.id,
    ]);
  });
});

describe('graph-recall.ts:248 graph-hop ordering', () => {
  function mem(home: string, tenant: string, text: string): MemoryEntry {
    const m = createMemory(text, {
      tags: [],
      layer: Layer.Semantic,
      confidence: 'verified',
      source: 'test',
      tenantId: tenant,
    });
    writeEntry(home, m, { actor: 'test' });
    return m;
  }
  function sr(entry: MemoryEntry, score: number): SearchResult {
    return { entry, score, bm25: score, cosine: 0, tokens: estimateTokens(entry.content) };
  }
  function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
    return insertEntityAt(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
  }

  let home: string;
  const T = 'default';
  beforeEach(() => {
    home = makeRoot('hop-tiebreak');
  });

  it('primary wins (hop distance) and the tail decides same-hop ties', async () => {
    const a = mem(home, T, 'origin alpha node for hop ordering test');
    const ea = ent(home, T, a, 'A');

    const b = mem(home, T, 'aaa hop one neighbor left of origin');
    const c = mem(home, T, 'zzz hop one neighbor right of origin');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelationAt(home, T, { fromEntityId: ea, toEntityId: ec, relType: 'supersedes', memoryId: a.id });

    const d = mem(home, T, 'mmm hop two neighbor reached via b');
    const ed = ent(home, T, d, 'D');
    insertRelationAt(home, T, { fromEntityId: eb, toEntityId: ed, relType: 'supersedes', memoryId: b.id });

    const base = [sr(a, 1.0)];
    const out = await graphExpandRecall(base, {
      hops: 2,
      store: sqliteStore(home),
      tenantId: T,
      budget: 40_000,
      includeSuperseded: true,
    });

    const ids = out.map((r) => r.entry.id);
    expect(ids).toEqual([a.id, b.id, c.id, d.id]);
  });
});
