#!/usr/bin/env node
/**
 * Pre-lock mechanism probe for the lifecycle stress eval (the (b) dry-run +
 * gates G2/G3/G4). NOT the harness - a minimal check that the HEADLINE
 * mechanism FIRES before building the full thing:
 *   1. consolidate() merges near-duplicate episodic clusters (G3 merge fires)
 *   2. the consolidated summary CARRIES the per-fact answer token (score-by-value works)
 *   3. the summary OUTRANKS the weakened (x0.3) originals so per-fact footprint drops
 *   4. physicsSearch is callable read-only, budget-packed (G2 path)
 * Hermetic: a throwaway temp store, local embeddings, no network (G4).
 *
 * Run: node scripts/lifecycle-stress/probe.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemory } from '../../dist/memory.js';
import { writeEntry, loadAllEntries, initStore } from '../../dist/store.js';
import { embedMemory, isEmbeddingAvailable, loadEmbeddingIndex } from '../../dist/embeddings.js';
import { physicsSearch } from '../../dist/search.js';
import { consolidate } from '../../dist/consolidate.js';
import { resetAllPhysicsState, loadPhysicsState } from '../../dist/physics-state.js';
import { openHippoDb, closeHippoDb } from '../../dist/db.js';
import { DEFAULT_PHYSICS_CONFIG } from '../../dist/physics-config.js';

const base = path.join(os.tmpdir(), `hippo-lse-probe-${process.pid}`);
const root = path.join(base, '.hippo');
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
initStore(root);
// Hermetic + deterministic: disable the wall-clock-seeded replay pass (same as the harness).
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }));

if (!isEmbeddingAvailable()) { console.error('NO_EMBEDDINGS - cannot run physics path'); process.exit(2); }

// 4 queried facts, each as 3 near-duplicate episodic memories. The opaque
// answer token is inside the first 120 chars of the first line of every member
// (so it survives both the k=2 and k>=3 merge paths). Variants are near-
// identical (high token overlap -> clears the 0.35 Jaccard merge threshold).
const facts = [
  { key: 'falcon', topic: 'Project Falcon deadline', ans: 'ANS4821', filler: 'engineering milestone fixed during autumn hardware bringup' },
  { key: 'atlas',  topic: 'Atlas budget cap',        ans: 'ANS7390', filler: 'finance ceiling locked after procurement spreadsheet review' },
  { key: 'nova',   topic: 'Nova release owner',      ans: 'ANS1145', filler: 'staffing assignment recorded in launch readiness tracker' },
  { key: 'orion',  topic: 'Orion vendor contract',   ans: 'ANS6628', filler: 'legal agreement signed following supplier diligence calls' },
];
// within-fact: variants share topic+ans+filler (Jaccard high -> merge). cross-fact:
// distinct topic+ans+filler (Jaccard low -> no cross-fact cluster). No shared boilerplate.
const variants = (f) => [
  `${f.topic} is ${f.ans}. The ${f.filler}.`,
  `${f.topic} equals ${f.ans}. The ${f.filler}.`,
  `${f.topic}, namely ${f.ans}. The ${f.filler}.`,
];

const createdOrder = []; // insertion order = recency proxy (facts first, distractors newest)
function add(content, tags) {
  const e = createMemory(content, { tags, source: 'lse-probe' });
  writeEntry(root, e);
  createdOrder.push(e.id);
}
for (const f of facts) for (const v of variants(f)) add(v, ['probe', `fact:${f.key}`]);
for (let i = 0; i < 24; i++) add(`Unrelated status note ${i}: routine filler about workstream ${i}.`, ['probe', 'distractor']);

async function embedAll() {
  for (const e of loadAllEntries(root)) await embedMemory(root, e);
  // Refresh physics particles from CURRENT strength so post-consolidate weakened
  // mass is actually scored (codex P1: embedMemory only builds a particle if absent).
  const entries = loadAllEntries(root);
  const index = loadEmbeddingIndex(root);
  const db = openHippoDb(root);
  try { resetAllPhysicsState(db, entries, index); } finally { closeHippoDb(db); }
}
await embedAll();

const B = 80;
const pc = { ...DEFAULT_PHYSICS_CONFIG, enabled: true };
const tok = (s) => Math.ceil(s.length / 4);
const hasAns = (results, f) => results.some((r) => (r.entry.content || '').includes(f.ans));

// naive-append (recency-fill): newest-first (reverse insertion order) to budget B. Fact-independent.
function naiveAnswered(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newestFirst = [...createdOrder].reverse().map((id) => byId.get(id)).filter(Boolean);
  const ctx = []; let used = 0;
  for (const e of newestFirst) { const t = tok(e.content); if (ctx.length >= 1 && used + t > B) continue; used += t; ctx.push({ entry: e }); }
  let n = 0; for (const f of facts) if (hasAns(ctx, f)) n++;
  return n;
}
// hippo retrieval: per-fact physicsSearch at budget B, check answer token present.
async function hippoAnswered(entries) {
  let n = 0;
  for (const f of facts) {
    const res = await physicsSearch(f.topic, entries, { hippoRoot: root, physicsConfig: pc, budget: B, minResults: 1 });
    if (hasAns(res, f)) n++;
  }
  return n;
}

const before = loadAllEntries(root);
const naiveAns = naiveAnswered(before);
const hippoNoLifeAns = await hippoAnswered(before);

// consolidate (merge the dupe clusters), then RE-EMBED (the new summary needs an embedding to be retrievable)
const cons = await consolidate(root);
await embedAll();
const after = loadAllEntries(root);
const hippoFullAns = await hippoAnswered(after);

const summaries = after.filter((e) => (e.content || '').startsWith('[Consolidated'));
let summaryCarriesAns = 0;
for (const f of facts) if (summaries.some((s) => s.content.includes(f.ans))) summaryCarriesAns++;

// footprint: for facts[0], at a very tight budget, is the top result the consolidated summary?
const tight = await physicsSearch(facts[0].topic, after, { hippoRoot: root, physicsConfig: pc, budget: 30, minResults: 1 });
const topIsSummary = tight.length > 0 && (tight[0].entry.content || '').startsWith('[Consolidated') && tight[0].entry.content.includes(facts[0].ans);
const _db = openHippoDb(root);
let _pmap; try { _pmap = loadPhysicsState(_db); } finally { closeHippoDb(_db); }
const diag = (await physicsSearch(facts[0].topic, after, { hippoRoot: root, physicsConfig: pc, budget: 100000, minResults: 5 }))
  .slice(0, 4).map((r) => ({ score: Number(r.score?.toFixed ? r.score.toFixed(3) : r.score), strength: Number((r.entry.strength || 0).toFixed(3)), particleMass: Number((_pmap.get(r.entry.id)?.mass ?? -1).toFixed(3)), layer: r.entry.layer, c: (r.entry.content || '').slice(0, 45) }));
console.log('TOP4 fact0 after consolidate (particleMass = what physicsSearch scores on):', JSON.stringify(diag, null, 2));

// Strength-sorted (no-query ambient) assembly: sort by strength desc, pack to B.
// This is the OTHER real getContext mode; consolidation's compact high-strength
// summaries should float to the top here (unlike the relevance path above).
function strengthSorted(entries, budget) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // Round strength (read-time age-decay micro-varies it) so within-tier ties break
  // deterministically by content. See run.mjs strengthSortedAssemble for the why.
  const sKey = (e) => Math.round((e.strength || 0) * 1000);
  const sorted = [...entries].sort((a, b) => (sKey(b) - sKey(a)) || cmp(a.content || '', b.content || ''));
  const ctx = []; let used = 0;
  for (const e of sorted) { const t = Math.ceil((e.content || '').length / 4); if (ctx.length >= 1 && used + t > budget) break; used += t; ctx.push(e); }
  let n = 0; for (const f of facts) if (ctx.some((e) => (e.content || '').includes(f.ans))) n++;
  return { factsAnswered: n, ctxSize: ctx.length, tokens: used };
}
const ssNoLife = strengthSorted(before, B);
const ssFull = strengthSorted(after, B);
console.log('STRENGTH-SORTED (B=' + B + '): noLifecycle=' + JSON.stringify(ssNoLife) + '  full=' + JSON.stringify(ssFull));

const out = {
  B,
  entriesBefore: before.length,
  entriesAfter: after.length,
  merged: cons.merged,
  semanticCreated: cons.semanticCreated,
  summaries: summaries.length,
  summaryCarriesAns, factsTotal: facts.length,
  naiveAns, hippoNoLifeAns, hippoFullAns,
  topIsSummaryForFact0: topIsSummary,
  PASS_merge_fires: cons.semanticCreated > 0,
  PASS_summary_carries_answer: summaryCarriesAns === facts.length,
  PASS_summary_outranks_originals: topIsSummary,
  PASS_hippo_beats_naive: hippoFullAns > naiveAns,
};
out.PROBE_PASS = out.PASS_merge_fires && out.PASS_summary_carries_answer && out.PASS_summary_outranks_originals && out.PASS_hippo_beats_naive;
console.log(JSON.stringify(out, null, 2));
fs.rmSync(base, { recursive: true, force: true });
// Report-only diagnostic: a `false` flag (e.g. the summary does not outrank the
// weakened originals) is an expected FINDING, not a probe failure. Exit 0 unless
// the probe itself crashed.
process.exit(0);
