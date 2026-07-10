/**
 * T3 primary-key-preservation tests (docs/plans/2026-07-09-recall-determinism.md).
 *
 * The T2 rule for non-score-primary sort sites is: the site's true primary
 * key must keep winning; compareEntryIdentity (src/compare.ts) is ONLY a
 * tail for when the primary key ties. Each site below gets a "primary
 * wins" case (real pipeline where practical) plus a "tail decides" tie
 * case (comparator-level where invoking the full pipeline to engineer an
 * exact tie would be disproportionate — sanctioned by the plan).
 *
 * Sites covered:
 *   - api.ts:833      DAG-substitution ordering (overflow-child count desc)
 *   - cli.ts:1167     --evc-adaptive ordering (recency desc)
 *   - graph-recall.ts:248  graph-hop ordering (hops asc, then score desc)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry, MemoryKind } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';
import { estimateTokens, type SearchResult } from '../src/search.js';
import { insertEntity, insertRelation } from '../src/graph.js';
import { graphExpandRecall } from '../src/graph-recall.js';
import { compareEntryIdentity } from '../src/compare.js';

function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// api.ts:833 — DAG-substitution ordering (overflow-child count desc)
// ---------------------------------------------------------------------------

describe('api.ts:833 DAG substitution ordering', () => {
  function makeRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
    mkdirSync(join(root, '.hippo'), { recursive: true });
    initStore(root);
    return root;
  }
  function ctxFor(root: string, tenantId: string = 'default'): Context {
    return { hippoRoot: root, tenantId, actor: { subject: 'test:tiebreak', role: 'admin' } };
  }
  function makeLeaf(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
    return createMemory(text, {
      layer: Layer.Buffer,
      tags: opts.tags ?? [],
      confidence: 'observed',
      dag_level: opts.dag_level ?? 0,
      dag_parent_id: opts.dag_parent_id,
      tenantId: opts.tenantId ?? 'default',
      kind: (opts.kind ?? 'distilled') as MemoryKind,
    });
  }
  function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
    return createMemory(text, {
      layer: Layer.Semantic,
      tags: opts.tags ?? ['dag-summary'],
      confidence: 'inferred',
      dag_level: 2,
      tenantId: opts.tenantId ?? 'default',
    });
  }

  let root: string;
  beforeEach(() => { root = makeRoot('dag-tiebreak'); });
  afterEach(() => safeRmSync(root));

  it('primary wins: the summary with MORE overflowing children is substituted, not the one with fewer', () => {
    // Every leaf under both topics tokenizes to the SAME 4-term bag ("alpha
    // zulu topic event") — the numeric/letter suffix ("a-0", "b-3", ...) is
    // stripped by tokenize()'s length>1 filter (hyphen splits it into two
    // 1-char tokens). So all 9 leaves score EXACTLY equal under BM25; with
    // limit=1 the single baseSlice winner is decided purely by our T2
    // content-ascending tiebreak, i.e. deterministically "alpha zulu topic
    // event a-0" (topic A's own leaf 0). That leaves topic A's overflow
    // count at 2 (3 - 1) and topic B's at 6 (untouched) REGARDLESS of any
    // scoring wobble — 6 > 2 always holds, so this isolates the overflow-
    // count primary key from the tiebreak being tested elsewhere.
    const summaryA = makeSummary('topic A summary', { tags: ['dag-summary', 'topic:a'] });
    writeEntry(root, summaryA);
    for (let i = 0; i < 3; i++) {
      writeEntry(root, makeLeaf(`alpha zulu topic event a-${i}`, {
        dag_level: 1,
        dag_parent_id: summaryA.id,
      }));
    }

    const summaryB = makeSummary('topic B summary', { tags: ['dag-summary', 'topic:b'] });
    writeEntry(root, summaryB);
    for (let i = 0; i < 6; i++) {
      writeEntry(root, makeLeaf(`alpha zulu topic event b-${i}`, {
        dag_level: 1,
        dag_parent_id: summaryB.id,
      }));
    }

    // maxSub = max(1, ceil(limit * 0.3)) = 1 at limit=1, so only the WINNING
    // (highest overflow count) summary is substituted — a clean single-slot
    // assertion instead of inspecting relative order in a longer list.
    const r = recall(ctxFor(root), { query: 'alpha zulu topic event', limit: 1 });
    const summaries = r.results.filter((it) => it.isSummary);
    expect(summaries.length).toBe(1);
    expect(summaries[0].id).toBe(summaryB.id); // topic B (6 overflow) beats topic A (2 overflow)
  });

  it('tail decides: equal overflow counts fall back to compareEntryIdentity (content ascending)', () => {
    // Engineering an EXACT overflow-count tie end-to-end through recall()
    // depends on which leaf wins baseSlice, which is itself governed by the
    // same tiebreak under test — disproportionate to pin reliably. Per the
    // plan's explicit allowance, test the api.ts:833 comparator expression
    // directly at the sorted-array level (same expression, just inlined —
    // api.ts does not export it).
    const parentA = { id: 'parent-zzz', content: 'zzz summary of topic zzz', tags: [] } as unknown as MemoryEntry;
    const parentB = { id: 'parent-aaa', content: 'aaa summary of topic aaa', tags: [] } as unknown as MemoryEntry;
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
    // counts tie -> content ascending: 'aaa summary...' < 'zzz summary...'
    expect(eligibleParents.map((p) => p.id)).toEqual([parentB.id, parentA.id]);
  });
});

// ---------------------------------------------------------------------------
// cli.ts:1167 — --evc-adaptive ordering (recency desc)
// ---------------------------------------------------------------------------

describe('cli.ts:1167 --evc-adaptive ordering', () => {
  // cli.ts:1167's `onTopic.sort(...)` is a local closure inside `cmdRecall`
  // (not exported — cmdRecall is CLI-internal), and a CLI-process spawn
  // (execFileSync against bin/hippo.js) would run the COMPILED dist/cli.js,
  // which this session must not rebuild (shared node_modules junction; the
  // orchestrator builds after all executors land — see episode brief). So
  // per the plan's explicit allowance, this is a sorted-array-level test of
  // the exact comparator expression now at cli.ts:1167, re-declared here
  // (not exported, to avoid widening cli.ts's public surface for a test).
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
    const older: OnTopicRow = { entry: { created: '2020-01-01T00:00:00.000Z', content: 'zzz older but higher score', id: 'id-older' }, score: 9 };
    const newer: OnTopicRow = { entry: { created: '2026-01-01T00:00:00.000Z', content: 'aaa newer but lower score', id: 'id-newer' }, score: 1 };
    // Shuffle input order so the result isn't an accidental array-order no-op.
    expect(sortOnTopic([older, newer]).map((r) => r.entry.id)).toEqual([newer.entry.id, older.entry.id]);
    expect(sortOnTopic([newer, older]).map((r) => r.entry.id)).toEqual([newer.entry.id, older.entry.id]);
  });

  it('tail decides: entries created at the exact same timestamp fall back to compareEntryIdentity (content ascending)', () => {
    const tiedTimestamp = '2026-03-01T00:00:00.000Z';
    const higherScore: OnTopicRow = { entry: { created: tiedTimestamp, content: 'zebra higher pre-evc score', id: 'id-z' }, score: 9 };
    const lowerScore: OnTopicRow = { entry: { created: tiedTimestamp, content: 'apple lower pre-evc score', id: 'id-a' }, score: 1 };
    // Recency ties -> content ascending decides ('apple...' < 'zebra...'),
    // NOT score (which would have put higherScore first) and not input order.
    expect(sortOnTopic([higherScore, lowerScore]).map((r) => r.entry.id)).toEqual([lowerScore.entry.id, higherScore.entry.id]);
  });
});

// ---------------------------------------------------------------------------
// graph-recall.ts:248 — graph-hop ordering (hops asc, then score desc, then
// compareEntryIdentity tail)
// ---------------------------------------------------------------------------

describe('graph-recall.ts:248 graph-hop ordering', () => {
  function makeRoot(): string {
    const home = mkdtempSync(join(tmpdir(), 'hippo-hop-tiebreak-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);
    return home;
  }
  function mem(home: string, tenant: string, text: string): MemoryEntry {
    const m = createMemory(text, { tags: [], layer: Layer.Semantic, confidence: 'verified', source: 'test', tenantId: tenant });
    writeEntry(home, m, { actor: 'test' });
    return m;
  }
  function sr(entry: MemoryEntry, score: number): SearchResult {
    return { entry, score, bm25: score, cosine: 0, tokens: estimateTokens(entry.content) };
  }
  function ent(home: string, tenant: string, m: MemoryEntry, name: string): number {
    return insertEntity(home, tenant, { entityType: 'decision', name, memoryId: m.id }).id;
  }

  let home: string;
  const T = 'default';
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => safeRmSync(home));

  it('primary wins (hop distance) and the tail decides same-hop ties', () => {
    // a (origin, base seed) --1hop--> b, c (tied score: same origin+hop under
    // the score = originScore * (1 - HOP_DISCOUNT*hops) formula) --1hop from
    // b--> d (2 hops from a, therefore strictly lower score than b/c under
    // that SAME formula — hops and score can never disagree for one origin,
    // which is exactly why this sort's real job is: same-hop ties broken by
    // content, and hop-groups never interleave).
    const a = mem(home, T, 'origin alpha node for hop ordering test');
    const ea = ent(home, T, a, 'A');

    const b = mem(home, T, 'aaa hop one neighbor left of origin');
    const c = mem(home, T, 'zzz hop one neighbor right of origin');
    const eb = ent(home, T, b, 'B');
    const ec = ent(home, T, c, 'C');
    insertRelation(home, T, { fromEntityId: ea, toEntityId: eb, relType: 'supersedes', memoryId: a.id });
    insertRelation(home, T, { fromEntityId: ea, toEntityId: ec, relType: 'supersedes', memoryId: a.id });

    const d = mem(home, T, 'mmm hop two neighbor reached via b');
    const ed = ent(home, T, d, 'D');
    insertRelation(home, T, { fromEntityId: eb, toEntityId: ed, relType: 'supersedes', memoryId: b.id });

    const base = [sr(a, 1.0)];
    const out = graphExpandRecall(base, {
      hops: 2, hippoRoot: home, tenantId: T, budget: 40_000, includeSuperseded: true,
    });

    const ids = out.map((r) => r.entry.id);
    // a (seed) first, then its hits in hitsByOrigin sort order: hop=1 group
    // (b, c — tied score, content tail puts 'aaa...' before 'zzz...') BEFORE
    // the hop=2 hit (d), regardless of any score magnitude.
    expect(ids).toEqual([a.id, b.id, c.id, d.id]);
  });
});
