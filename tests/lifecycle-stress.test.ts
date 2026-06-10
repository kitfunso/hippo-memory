/**
 * Lifecycle stress eval — harness unit tests.
 *
 * Real SQLite store, NO mocks (project rule). Tiny corpora + low budget so the
 * suite stays fast. Each test isolates its own temp HIPPO_HOME under os.tmpdir()
 * (never cwd/.hippo or the global store), so tests/_real-store-guard.ts cannot
 * false-positive on a leak.
 *
 * Covers:
 *   1. injector determinism      — same seed => byte-identical stream
 *   2. value-based metric        — the by-fact-value scoring is correct
 *   3. merge fires + answer survives (mirrors scripts/lifecycle-stress/probe.mjs)
 *   4. G1 leak sanity            — noise-only store => fact answer absent at floor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, type MemoryEntry } from '../src/memory.js';
import { embedMemory, isEmbeddingAvailable } from '../src/embeddings.js';
import { physicsSearch, substituteDagSummaries } from '../src/search.js';
import { consolidate } from '../src/consolidate.js';
import { DEFAULT_PHYSICS_CONFIG } from '../src/physics-config.js';

import { injectStream } from '../scripts/lifecycle-stress/inject.mjs';

const PC = { ...DEFAULT_PHYSICS_CONFIG, enabled: true };
const tok = (s: string): number => Math.ceil((s || '').length / 4);

// Mirrors run.mjs unionPerFact (per-fact physicsSearch union -> global repack)
// WITH the DAG slice 1 substitution at the binding site. Re-implemented here so
// the test pins the assembled-context contract independently of the harness.
async function unionPerFactAssemble(
  entries: MemoryEntry[],
  B: number,
  labels: { topic: string }[],
  root: string,
  substitute = true,
): Promise<{ entry: MemoryEntry }[]> {
  const seen = new Map<string, { entry: MemoryEntry; bestRank: number }>();
  for (const lab of labels) {
    const res = await physicsSearch(lab.topic, entries, {
      hippoRoot: root, physicsConfig: PC, budget: B, minResults: 1,
      summaryDeboost: 1.0, summaryFreshness: false,
    });
    for (let i = 0; i < res.length; i++) {
      const id = res[i].entry.id;
      const prev = seen.get(id);
      if (!prev || i < prev.bestRank) seen.set(id, { entry: res[i].entry, bestRank: i });
    }
  }
  const rankedAll = [...seen.values()].sort((a, b) => a.bestRank - b.bestRank);
  const ranked = substitute ? substituteDagSummaries(rankedAll, { minChildren: 2 }) : rankedAll;
  const ctx: { entry: MemoryEntry }[] = [];
  let used = 0;
  for (const v of ranked) {
    const t = tok(v.entry.content);
    if (ctx.length >= 1 && used + t > B) continue;
    used += t;
    ctx.push({ entry: v.entry });
  }
  return ctx;
}

// Re-implements run.mjs scoreAssembled by-value logic so the test pins the
// scoring contract independently of the harness module's internals. Out-rank is
// by a STALE token of the SAME fact (pre-reg axis 1); the 4 main conditions have
// no stale tokens, so presence is the metric there.
function scoreAssembled(
  assembled: { entry: { content: string } }[],
  labels: { factKey: string; topic: string; answerToken: string; staleTokens?: string[] }[],
): { answered: number; tokens: number } {
  const tokens = assembled.reduce((s, r) => s + tok(r.entry.content), 0);
  let answered = 0;
  for (const lab of labels) {
    const stale = lab.staleTokens ?? [];
    let firstCurrent = -1;
    let firstStale = -1;
    for (let i = 0; i < assembled.length; i++) {
      const c = assembled[i].entry.content || '';
      if (firstCurrent < 0 && c.includes(lab.answerToken)) firstCurrent = i;
      if (firstStale < 0 && stale.some((t) => c.includes(t))) firstStale = i;
    }
    const present = firstCurrent >= 0;
    const outranked = firstStale >= 0 && (firstCurrent < 0 || firstStale < firstCurrent);
    if (present && !outranked) answered++;
  }
  return { answered, tokens };
}

describe('lifecycle-stress injector', () => {
  it('is deterministic: same seed produces a byte-identical stream + labels', () => {
    const opts = { seed: 7, scaleMemories: 80, numFacts: 6, dupesPerFact: 3 };
    const a = injectStream(opts);
    const b = injectStream(opts);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // different seed => different stream (answer tokens are seed-derived)
    const c = injectStream({ ...opts, seed: 8 });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('emits exactly scaleMemories memories with answer tokens in the first 120 chars', () => {
    const { memories, labels } = injectStream({ seed: 3, scaleMemories: 100, numFacts: 6, dupesPerFact: 3 });
    expect(memories.length).toBe(100);
    expect(labels.length).toBe(6);
    // every fact member carries its answer token in the first 120 chars of line 1
    for (const lab of labels) {
      // Fact membership is identified by the answer token in content (eval tags are
      // not written to the store, to avoid an embedded oracle signal).
      const members = memories.filter((m) => m.content.includes(lab.answerToken));
      expect(members.length).toBe(3);
      for (const m of members) {
        const firstLine120 = (m.content.split('\n')[0] || '').slice(0, 120);
        expect(firstLine120).toContain(lab.answerToken);
      }
    }
    // answer tokens are distinct across facts (no cross-fact collision)
    const toks = labels.map((l) => l.answerToken);
    expect(new Set(toks).size).toBe(toks.length);
  });
});

describe('lifecycle-stress value-based metric', () => {
  const labels = [
    { factKey: 'fact0', topic: 'T0', answerToken: 'ANS1111' },
    { factKey: 'fact1', topic: 'T1', answerToken: 'ANS2222' },
  ];

  it('counts both facts answered when present (no stale tokens => presence only)', () => {
    const assembled = [
      { entry: { content: 'T0 is ANS1111. filler.' } },
      { entry: { content: 'T1 is ANS2222. filler.' } },
    ];
    // coexisting correct tokens do NOT out-rank each other (out-rank is by a
    // SAME-fact stale token, of which there are none in the main conditions)
    expect(scoreAssembled(assembled, labels).answered).toBe(2);
  });

  it('credits a consolidated summary that carries the token (score by value, not id)', () => {
    const assembled = [
      { entry: { content: '[Consolidated from 3 related memories]\n- T0 is ANS1111\n- T0 equals ANS1111' } },
    ];
    // fact0 present via the summary; fact1 absent
    expect(scoreAssembled(assembled, labels).answered).toBe(1);
  });

  it('does NOT credit a fact whose CURRENT token is out-ranked by its own STALE token', () => {
    // supersession-arm contract: fact0 has a stale token ANS0000 that ranks
    // ahead of its current token ANS1111 => fact0 not answered.
    const staleLabels = [
      { factKey: 'fact0', topic: 'T0', answerToken: 'ANS1111', staleTokens: ['ANS0000'] },
      { factKey: 'fact1', topic: 'T1', answerToken: 'ANS2222' },
    ];
    const assembled = [
      { entry: { content: 'T0 was ANS0000 (old).' } }, // stale, ranks first
      { entry: { content: 'T0 is ANS1111 (current).' } }, // current, ranks second
      { entry: { content: 'T1 is ANS2222.' } },
    ];
    // fact0: current present at rank 1 but stale ANS0000 at rank 0 (before) => not answered
    // fact1: present, no stale => answered
    expect(scoreAssembled(assembled, staleLabels).answered).toBe(1);
  });

  it('sums active-context tokens via the len/4 estimator', () => {
    const assembled = [{ entry: { content: 'x'.repeat(40) } }]; // 40 chars => 10 tokens
    expect(scoreAssembled(assembled, labels).tokens).toBe(10);
  });
});

describe('lifecycle-stress mechanism (real DB, mirrors the probe)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-lse-test-'));
    root = path.join(base, '.hippo');
    initStore(root);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('merges near-duplicate clusters and the summary carries each answer token', async () => {
    if (!isEmbeddingAvailable()) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    const { memories, labels } = injectStream({ seed: 42, scaleMemories: 40, numFacts: 4, dupesPerFact: 3 });
    for (const m of memories) writeEntry(root, createMemory(m.content, { tags: m.tags, source: 'lse-test' }));
    for (const e of loadAllEntries(root)) await embedMemory(root, e);

    const cons = await consolidate(root, {});
    // merge must fire on the redundant clusters
    expect(cons.semanticCreated).toBeGreaterThan(0);

    for (const e of loadAllEntries(root)) await embedMemory(root, e);
    const after = loadAllEntries(root);
    // DAG slice 1: merge summaries are now real L2 DAG nodes (dag-summary tag,
    // dag_level=2), and the dense compressor output has NO "[Consolidated...]"
    // prefix. Identify summaries structurally.
    const summaries = after.filter((e) => e.tags.includes('dag-summary'));
    expect(summaries.length).toBeGreaterThan(0);

    // every redundant-cluster fact's answer token survives into SOME summary
    for (const lab of labels) {
      const carried = summaries.some((s) => (s.content || '').includes(lab.answerToken));
      expect(carried, `summary must carry ${lab.answerToken} for ${lab.factKey}`).toBe(true);
    }
  }, 60_000);

  it('answers each queried fact via physicsSearch after consolidate (token present)', async () => {
    if (!isEmbeddingAvailable()) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    const { memories, labels } = injectStream({ seed: 11, scaleMemories: 40, numFacts: 4, dupesPerFact: 3 });
    for (const m of memories) writeEntry(root, createMemory(m.content, { tags: m.tags, source: 'lse-test' }));
    for (const e of loadAllEntries(root)) await embedMemory(root, e);
    await consolidate(root, {});
    for (const e of loadAllEntries(root)) await embedMemory(root, e);
    const after = loadAllEntries(root);

    // at a generous budget every fact's token must be retrievable by its topic
    for (const lab of labels) {
      const res = await physicsSearch(lab.topic, after, { hippoRoot: root, physicsConfig: PC, budget: 2000, minResults: 1 });
      const present = res.some((r) => (r.entry.content || '').includes(lab.answerToken));
      expect(present, `fact ${lab.factKey} token ${lab.answerToken} must be retrievable`).toBe(true);
    }
  }, 60_000);

  it('unionPerFact assembly excludes substituted children and packs fewer tokens than the children sum', async () => {
    if (!isEmbeddingAvailable()) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    const B = 1500;
    const { memories, labels } = injectStream({ seed: 23, scaleMemories: 60, numFacts: 4, dupesPerFact: 3 });
    for (const m of memories) writeEntry(root, createMemory(m.content, { tags: m.tags, source: 'lse-test' }));
    for (const e of loadAllEntries(root)) await embedMemory(root, e);

    const cons = await consolidate(root, {});
    expect(cons.semanticCreated).toBeGreaterThan(0);
    for (const e of loadAllEntries(root)) await embedMemory(root, e);
    const entries = loadAllEntries(root);

    const summaries = entries.filter((e) => e.tags.includes('dag-summary'));
    expect(summaries.length).toBeGreaterThan(0);
    const summaryIds = new Set(summaries.map((s) => s.id));

    // Build the per-fact union WITHOUT substitution (the raw candidate set the
    // global repack sees), then the assembled context WITH substitution. The
    // substitution contract keys on children PRESENT in the union (>=2), not on
    // the store's total child count — so the invariant is asserted against the
    // union, not against `entries`.
    const rawUnion = await unionPerFactAssemble(entries, B, labels, root, /* substitute */ false);
    const rawIds = new Set(rawUnion.map((r) => r.entry.id));
    const assembled = await unionPerFactAssemble(entries, B, labels, root);
    const assembledIds = new Set(assembled.map((r) => r.entry.id));

    // INVARIANT: for every summary present in the assembled context, if >=2 of
    // its children were in the raw union, none of THOSE children may remain in
    // the assembled context — the summary substituted for them.
    let firedForSome = false;
    for (const s of summaries) {
      if (!assembledIds.has(s.id)) continue;
      const childrenInUnion = entries.filter((e) => e.dag_parent_id === s.id && rawIds.has(e.id));
      if (childrenInUnion.length >= 2) {
        firedForSome = true;
        const stillThere = childrenInUnion.filter((c) => assembledIds.has(c.id));
        expect(stillThere.length, `summary ${s.id} packed but kept substituted children`).toBe(0);
      }
    }
    // mechanism actually fired for at least one summary (not vacuous).
    expect(firedForSome, 'substitution should fire for at least one packed summary').toBe(true);

    // Token footprint: for the packed summaries that substituted, the summaries'
    // total tokens are strictly fewer than the tokens of the children they stood
    // in for (the children that were in the raw union). This is the budget win.
    let summaryTokens = 0;
    let replacedChildTokens = 0;
    for (const s of summaries) {
      if (!assembledIds.has(s.id)) continue;
      const childrenInUnion = entries.filter((e) => e.dag_parent_id === s.id && rawIds.has(e.id));
      if (childrenInUnion.length >= 2) {
        summaryTokens += tok(s.content);
        replacedChildTokens += childrenInUnion.reduce((a, c) => a + tok(c.content), 0);
      }
    }
    expect(replacedChildTokens).toBeGreaterThan(0);
    expect(summaryTokens).toBeLessThan(replacedChildTokens);
  }, 60_000);

  it('G1 leak sanity: a noise-only store does not surface any fact answer token', async () => {
    if (!isEmbeddingAvailable()) {
      console.warn('SKIP: embeddings unavailable in this environment');
      return;
    }
    // labels for facts that are NEVER injected (noise-only store)
    const { labels } = injectStream({ seed: 99, scaleMemories: 40, numFacts: 4, dupesPerFact: 3 });
    // Noise-only: facts are injected first, so the distractors are everything after
    // the fact members (numFacts*dupesPerFact = 2*2 = 4). No tag filter needed.
    const noise = injectStream({ seed: 99, scaleMemories: 40, numFacts: 2, dupesPerFact: 2 }).memories
      .slice(2 * 2);
    expect(noise.length).toBeGreaterThan(0);
    for (const m of noise) writeEntry(root, createMemory(m.content, { tags: m.tags, source: 'lse-test' }));
    for (const e of loadAllEntries(root)) await embedMemory(root, e);
    const entries = loadAllEntries(root);

    // no answer token from the (un-injected) fact labels may appear anywhere
    for (const lab of labels) {
      const leaked = entries.some((e) => (e.content || '').includes(lab.answerToken));
      expect(leaked, `noise store must not contain ${lab.answerToken}`).toBe(false);
      // and a topic query must not retrieve it either (floor)
      const res = await physicsSearch(lab.topic, entries, { hippoRoot: root, physicsConfig: PC, budget: 200, minResults: 1 });
      expect(res.some((r) => (r.entry.content || '').includes(lab.answerToken))).toBe(false);
    }
  }, 60_000);
});
