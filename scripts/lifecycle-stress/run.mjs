#!/usr/bin/env node
/**
 * Lifecycle stress eval (first slice) — the HARNESS.
 *
 * Measures, under a FIXED active-context token budget B, whether hippo's
 * lifecycle (the consolidate/sleep merge pass) lets a budget-bounded context
 * answer MORE distinct queried facts than recency or relevance-without-
 * lifecycle, as a single store grows.
 *
 * THIS IS AN HONEST-NULL EVAL. A working probe already showed the headline
 * mechanism does NOT fire (consolidated summaries rank BELOW the strength-
 * weakened 0.3 source episodics: embedding relevance dominates the mass
 * advantage). This harness faithfully measures whatever the numbers are. It
 * does not tune, bias, or manufacture a positive result. The deliverable is
 * the reusable ruler + the honest finding.
 *
 * For each (seed x checkpoint x condition):
 *   - build a HERMETIC isolated store (fresh temp HIPPO_HOME under os.tmpdir(),
 *     empty global, cleaned up after), inject, embed;
 *   - for hippo-full: consolidate() then RE-EMBED (the new semantic summary
 *     needs an embedding to be retrievable), per the probe.
 *
 * Conditions (all read the same injected stream, all answer within budget B):
 *   1. naive-append    recency-fill, newest-first to B (pure fn over the stream)
 *   2. recency-window  keep last-N by 2*B tokens, then physicsSearch in window
 *   3. hippo-no-lifecycle  physicsSearch over all, NO consolidate
 *   4. hippo-full      consolidate + re-embed + physicsSearch over all
 *
 * Scoring is BY FACT VALUE (a condition answers fact F iff any assembled entry
 * content includes F's opaque answer token), never by source memory id.
 *
 * Hermetic: local embeddings only, no network, ANTHROPIC_API_KEY never set.
 *
 * Run (tractable smoke):
 *   node scripts/lifecycle-stress/run.mjs --facts 6 --dupes 3 \
 *        --checkpoints 1x,10x --seeds 4 --budget 1500
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemory } from '../../dist/memory.js';
import { writeEntry, loadAllEntries, initStore } from '../../dist/store.js';
import { embedMemory, isEmbeddingAvailable, loadEmbeddingIndex } from '../../dist/embeddings.js';
import { physicsSearch, substituteDagSummaries } from '../../dist/search.js';
import { consolidate } from '../../dist/consolidate.js';
import { resetAllPhysicsState } from '../../dist/physics-state.js';
import { openHippoDb, closeHippoDb } from '../../dist/db.js';
import { DEFAULT_PHYSICS_CONFIG } from '../../dist/physics-config.js';

import { injectStream, writeLabelSidecar, mulberry32 } from './inject.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO, 'benchmarks', 'lifecycle-stress');

// Checkpoint label -> memory count.
const CHECKPOINT_COUNTS = { '1x': 100, '10x': 1000, '100x': 10000 };

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const CHECKPOINTS = flag('--checkpoints', '1x,10x,100x')
  .split(',').map((s) => s.trim()).filter(Boolean);
const NUM_SEEDS = parseInt(flag('--seeds', '20'), 10);
const NUM_FACTS = parseInt(flag('--facts', '6'), 10);
const DUPES = parseInt(flag('--dupes', '3'), 10);
const BUDGET = parseInt(flag('--budget', '1500'), 10);
// DAG slice 1 — A/B control: set LSE_NO_SUBSTITUTE=1 to disable summary->children
// substitution at BOTH sites (physicsSearch pack + the global repack), isolating
// the compression/dag-node effect from the substitution effect. Default ON.
const SUBSTITUTE = !process.env.LSE_NO_SUBSTITUTE;

for (const cp of CHECKPOINTS) {
  if (!(cp in CHECKPOINT_COUNTS)) {
    console.error(`Unknown checkpoint "${cp}". Known: ${Object.keys(CHECKPOINT_COUNTS).join(', ')}`);
    process.exit(2);
  }
}

const PC = { ...DEFAULT_PHYSICS_CONFIG, enabled: true };
const tok = (s) => Math.ceil((s || '').length / 4);

// ---------------------------------------------------------------------------
// Deterministic paired bootstrap CI.
//
// Reuses physics-ablation.mjs's paired bootstrap shape (resample WITH
// replacement, take the alpha/2 and 1-alpha/2 percentiles of the resampled
// means) but seeds it with mulberry32 so the CI is reproducible. The harness
// bans Math.random everywhere, including here.
// ---------------------------------------------------------------------------

/** @param {number[]} diffs @returns {{meanDiff:number, low:number, high:number}} */
function pairedBootstrapCI(diffs, iters = 10000, alpha = 0.05) {
  const n = diffs.length;
  if (n === 0) return { meanDiff: 0, low: 0, high: 0 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const rng = mulberry32(0x9e3779b9);
  const boots = new Array(iters);
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[Math.floor(rng() * n)];
    boots[b] = s / n;
  }
  boots.sort((a, b) => a - b);
  const low = boots[Math.floor((alpha / 2) * iters)];
  const high = boots[Math.floor((1 - alpha / 2) * iters)];
  return { meanDiff: mean, low, high };
}

// ---------------------------------------------------------------------------
// Store build (hermetic, per seed x checkpoint).
// ---------------------------------------------------------------------------

/** Build + embed an isolated store; return {root, base, entries, createdOrder}. */
async function buildStore(memories) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-lse-'));
  const root = path.join(base, '.hippo');
  initStore(root);
  // Disable the replay pass for slice 1 (prereg mandate). Replay reinforces
  // wall-clock-SEEDED survivors during consolidate() (consolidate.ts:248-251),
  // which would (a) make the result non-deterministic and (b) lift weakened
  // originals back over the budget cut, diluting the compression measurement.
  // config.json merges with defaults (config.ts loadConfig), so this sets only
  // replay.count; decayBasis and the rest keep their defaults.
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }, null, 2));
  const createdOrder = [];
  for (const m of memories) {
    const e = createMemory(m.content, { tags: m.tags, source: 'lse' });
    writeEntry(root, e);
    createdOrder.push(e.id);
  }
  for (const e of loadAllEntries(root)) await embedMemory(root, e);
  return { base, root, createdOrder };
}

async function reEmbed(root) {
  // 1. Embed any new memories (the consolidation summary) into the index.
  for (const e of loadAllEntries(root)) await embedMemory(root, e);
  // 2. CRITICAL (codex P1): rebuild ALL physics particles from CURRENT strength.
  //    embedMemory only creates a particle when one is ABSENT (embeddings.ts:414-417),
  //    so after consolidate() weakens source episodics to strength*0.3 their particle
  //    MASS stays stale (built at strength 1.0) and physicsSearch would score the
  //    "weakened" originals at full mass - invalidating the lifecycle comparison.
  //    resetAllPhysicsState re-derives every particle (initializeParticle ->
  //    calculateStrength -> computeMass), so scoring reflects the weakening.
  const entries = loadAllEntries(root);
  const index = loadEmbeddingIndex(root);
  const db = openHippoDb(root);
  try {
    resetAllPhysicsState(db, entries, index);
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// Value-based scoring (pre-reg axis 1).
//
// QA accuracy: fraction of facts where the assembled context contains the
// fact's CURRENT answer token AND no entry carrying a STALE (superseded) token
// of the SAME fact out-ranks the first entry carrying the current token. This
// slice's 4 MAIN conditions inject no supersession, so every label has an empty
// stale-token set and the out-rank clause is vacuous => presence is the metric.
// The clause is kept wired so the supersession arm (a follow-up) drops in
// without re-deriving the metric. The SAME metric scores every condition, so it
// cannot bias hippo-full vs the baselines.
//
// Active-context tokens: sum of estimated tokens of the assembled entries.
// ---------------------------------------------------------------------------

/**
 * Score an ASSEMBLED, RANK-ORDERED list of entries against the labels.
 * @param {{entry:{content:string}}[]} assembled rank order (best first)
 * @param {{factKey:string, topic:string, answerToken:string, staleTokens?:string[]}[]} labels
 * @returns {{answered:number, tokens:number}}
 */
function scoreAssembled(assembled, labels) {
  const tokens = assembled.reduce((s, r) => s + tok(r.entry.content), 0);
  let answered = 0;
  for (const lab of labels) {
    const stale = lab.staleTokens ?? [];
    let firstCurrentRank = -1;
    let firstStaleRank = -1;
    for (let i = 0; i < assembled.length; i++) {
      const c = assembled[i].entry.content || '';
      if (firstCurrentRank < 0 && c.includes(lab.answerToken)) firstCurrentRank = i;
      if (firstStaleRank < 0 && stale.some((t) => c.includes(t))) firstStaleRank = i;
    }
    const present = firstCurrentRank >= 0;
    const outranked = firstStaleRank >= 0 && (firstCurrentRank < 0 || firstStaleRank < firstCurrentRank);
    if (present && !outranked) answered++;
  }
  return { answered, tokens };
}

// ---------------------------------------------------------------------------
// Conditions. Each returns the assembled rank-ordered entry list at budget B.
// Per-fact QA queries physicsSearch by the fact topic; the assembled context is
// the UNION of per-fact top results (dedup by id), which is what a multi-query
// agent would hold. naive/recency build one budget-B context independent of the
// fact (they have no query); QA then checks token presence in that context.
// ---------------------------------------------------------------------------

// naive-append: newest-first fill to B (pure function over the stream).
function naiveAssemble(entries, createdOrder, B) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newestFirst = [...createdOrder].reverse().map((id) => byId.get(id)).filter(Boolean);
  const ctx = [];
  let used = 0;
  for (const e of newestFirst) {
    const t = tok(e.content);
    if (ctx.length >= 1 && used + t > B) continue;
    used += t;
    ctx.push({ entry: e });
  }
  return ctx;
}

// strength-sorted (no-query ambient context): sort by strength desc, pack to B.
// The OTHER real getContext assembly mode (no-query strength fallback). Pure
// function over the entries; consolidation's high-strength summaries float to
// the top here (unlike the relevance path), so this is where any budget-
// compression benefit would show IF the summary were actually smaller than its
// sources. The probe showed it is not (a 3-member summary >= the 3 originals).
function strengthSortedAssemble(entries, B) {
  // Stable secondary key (content) so equal-strength ties do NOT fall back to
  // crypto.randomUUID id order (loadAllEntries created/id order), which would
  // make the strength-sorted columns non-deterministic across runs. Content is
  // seed-deterministic and unique per memory, so this makes the assembly a pure
  // function of the seed.
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  // Round strength to 3 decimals before comparing. hippo applies a tiny read-time
  // age-decay (created is wall-clock), so otherwise-same-tier rows differ in the
  // ~7th decimal across runs; without rounding the tie order (and token count)
  // is non-deterministic and the content key never engages. Rounding buckets the
  // real tiers (1.0 vs 0.3) while the deterministic content key breaks within-tier
  // ties, making the strength-sorted columns byte-identical across runs.
  const sKey = (e) => Math.round((e.strength || 0) * 1000);
  const sorted = [...entries].sort(
    (a, b) => (sKey(b) - sKey(a)) || cmp(a.content || '', b.content || ''),
  );
  const ctx = [];
  let used = 0;
  for (const e of sorted) {
    const t = tok(e.content);
    if (ctx.length >= 1 && used + t > B) continue;
    used += t;
    ctx.push({ entry: e });
  }
  return ctx;
}

// recency-window: keep the last-N whose cumulative tokens reach 2*B (newest
// first), then physicsSearch within that window, once per fact, union the tops.
async function recencyWindowAssemble(entries, createdOrder, B, labels, root) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newestFirst = [...createdOrder].reverse().map((id) => byId.get(id)).filter(Boolean);
  const window = [];
  let used = 0;
  for (const e of newestFirst) {
    used += tok(e.content);
    window.push(e);
    if (used >= 2 * B) break;
  }
  return unionPerFact(window, B, labels, root);
}

// hippo retrieval: per-fact physicsSearch over `entries`, union the budget-B
// results (dedup by id), preserving best per-fact rank for the out-rank check.
async function unionPerFact(entries, B, labels, root) {
  const seen = new Map(); // id -> {entry, bestRank}
  for (const lab of labels) {
    const res = await physicsSearch(lab.topic, entries, {
      hippoRoot: root, physicsConfig: PC, budget: B, minResults: 1,
      // DAG slice 1: neutralize the L2 ranking knobs on the eval path so the
      // dense compressor output (the source-level fix) is what makes the
      // summary compete on relevance — not a deboost/freshness thumb on the
      // scale. summaryDeboost:1.0 disables the deboost; summaryFreshness:false
      // disables the wall-clock-seeded boost (also keeps the run deterministic).
      // Per-fact substitution is left ON (default) but the BINDING substitution
      // is the global repack below (a child dropped here can re-enter via
      // another fact's call; the global repack is the single measured context).
      summaryDeboost: 1.0, summaryFreshness: false,
      substituteSummaryChildren: SUBSTITUTE,
    });
    for (let i = 0; i < res.length; i++) {
      const id = res[i].entry.id;
      if (!seen.has(id) || i < seen.get(id).bestRank) {
        seen.set(id, { entry: res[i].entry, bestRank: i });
      }
    }
  }
  // Global fixed-budget repack: pack the per-fact union into a SINGLE budget B
  // (best-ranked first), so the assembled context honors the fixed-budget premise
  // (one B-token context, NOT facts x B - the prior union returned ~facts*B). The
  // continue semantics (skip an over-budget item, keep filling with smaller ones)
  // match physicsSearch's own budget loop (search.ts:768).
  const rankedAll = [...seen.values()].sort((a, b) => a.bestRank - b.bestRank);
  // DAG slice 1 — THE BINDING substitution site: apply substituteDagSummaries to
  // the global union BEFORE the pack loop. Without this, a child dropped on fact
  // F's per-fact call is re-admitted via fact G (the round-2 crit). Applied
  // equally to every condition: a no-op for naive/recency/no-lifecycle (no
  // summaries), fires only for hippo-full. The summary occupies ONE slot where
  // its >=2 redundant children would have occupied K — that IS the DAG's value.
  const ranked = SUBSTITUTE ? substituteDagSummaries(rankedAll, { minChildren: 2 }) : rankedAll;
  const ctx = [];
  let used = 0;
  for (const v of ranked) {
    const t = tok(v.entry.content);
    if (ctx.length >= 1 && used + t > B) continue;
    used += t;
    ctx.push({ entry: v.entry });
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Run one (seed x checkpoint): build once, score all four conditions.
// hippo-full reuses the SAME built store but consolidates + re-embeds it; to
// keep hippo-no-lifecycle clean we build TWO stores (one consolidated, one not)
// from the identical injected stream so neither side-effects the other.
// ---------------------------------------------------------------------------

async function runCell(seed, checkpoint) {
  const scaleMemories = CHECKPOINT_COUNTS[checkpoint];
  const { memories, labels } = injectStream({
    seed, scaleMemories, numFacts: NUM_FACTS, dupesPerFact: DUPES,
  });
  writeLabelSidecar(path.join(OUT_DIR, 'labels'), { seed, scaleMemories, numFacts: NUM_FACTS, dupesPerFact: DUPES }, labels);

  // Store A: no-lifecycle (also serves naive + recency, which are read-only).
  const A = await buildStore(memories);
  const entriesA = loadAllEntries(A.root);

  const naive = scoreAssembled(naiveAssemble(entriesA, A.createdOrder, BUDGET), labels);
  const recency = scoreAssembled(await recencyWindowAssemble(entriesA, A.createdOrder, BUDGET, labels, A.root), labels);
  const noLife = scoreAssembled(await unionPerFact(entriesA, BUDGET, labels, A.root), labels);

  // Store B: consolidated (hippo-full). Fresh build so A stays untouched.
  const B = await buildStore(memories);
  const cons = await consolidate(B.root, {});
  await reEmbed(B.root);
  const entriesB = loadAllEntries(B.root);
  const full = scoreAssembled(await unionPerFact(entriesB, BUDGET, labels, B.root), labels);

  // Strength-sorted (ambient, no-query) assembly for the same two stores - the
  // mode where consolidation's compact high-strength summaries could compress.
  const noLifeSS = scoreAssembled(strengthSortedAssemble(entriesA, BUDGET), labels);
  const fullSS = scoreAssembled(strengthSortedAssemble(entriesB, BUDGET), labels);

  // budget-binding diagnostic: fraction of the store fitting B (naive view).
  const totalTokens = memories.reduce((s, m) => s + tok(m.content), 0);
  const fitFraction = Math.min(1, BUDGET / Math.max(1, totalTokens));

  fs.rmSync(A.base, { recursive: true, force: true });
  fs.rmSync(B.base, { recursive: true, force: true });

  const m = NUM_FACTS;
  return {
    seed, checkpoint, scaleMemories, facts: m,
    merged: cons.merged, semanticCreated: cons.semanticCreated,
    fitFraction,
    qa: {
      'naive-append': naive.answered / m,
      'recency-window': recency.answered / m,
      'hippo-no-lifecycle': noLife.answered / m,
      'hippo-full': full.answered / m,
      'hippo-no-lifecycle-strength': noLifeSS.answered / m,
      'hippo-full-strength': fullSS.answered / m,
    },
    tokens: {
      'naive-append': naive.tokens,
      'recency-window': recency.tokens,
      'hippo-no-lifecycle': noLife.tokens,
      'hippo-full': full.tokens,
      'hippo-no-lifecycle-strength': noLifeSS.tokens,
      'hippo-full-strength': fullSS.tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation + reporting.
// ---------------------------------------------------------------------------

const CONDITIONS = ['naive-append', 'recency-window', 'hippo-no-lifecycle', 'hippo-full', 'hippo-no-lifecycle-strength', 'hippo-full-strength'];

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function fmtPct(x) { return (100 * x).toFixed(1) + '%'; }
function sign(x) { return x >= 0 ? '+' : ''; }

function aggregate(cells) {
  // group by checkpoint
  const byCp = new Map();
  for (const c of cells) {
    if (!byCp.has(c.checkpoint)) byCp.set(c.checkpoint, []);
    byCp.get(c.checkpoint).push(c);
  }
  const perCheckpoint = {};
  for (const [cp, rows] of byCp) {
    const qa = {}, tokens = {};
    for (const cond of CONDITIONS) {
      qa[cond] = mean(rows.map((r) => r.qa[cond]));
      tokens[cond] = mean(rows.map((r) => r.tokens[cond]));
    }
    // paired per-seed deltas (sorted by seed for stable pairing)
    const sorted = [...rows].sort((a, b) => a.seed - b.seed);
    const dFullVsNoLife = sorted.map((r) => r.qa['hippo-full'] - r.qa['hippo-no-lifecycle']);
    const dFullVsNaive = sorted.map((r) => r.qa['hippo-full'] - r.qa['naive-append']);
    const dFullVsNoLifeSS = sorted.map((r) => r.qa['hippo-full-strength'] - r.qa['hippo-no-lifecycle-strength']);
    perCheckpoint[cp] = {
      seeds: rows.length,
      meanMerged: mean(rows.map((r) => r.merged)),
      meanSemanticCreated: mean(rows.map((r) => r.semanticCreated)),
      meanFitFraction: mean(rows.map((r) => r.fitFraction)),
      qa, tokens,
      deltas: {
        'hippo-full_vs_hippo-no-lifecycle': pairedBootstrapCI(dFullVsNoLife),
        'hippo-full_vs_naive-append': pairedBootstrapCI(dFullVsNaive),
        'hippo-full-strength_vs_hippo-no-lifecycle-strength': pairedBootstrapCI(dFullVsNoLifeSS),
      },
    };
  }
  return perCheckpoint;
}

function printMarkdown(agg, meta) {
  const lines = [];
  lines.push('# Lifecycle Stress Eval (first slice) — smoke results');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Budget B: ${meta.budget} tokens | facts: ${meta.facts} | dupes/fact: ${meta.dupes} | seeds: ${meta.seeds} | checkpoints: ${meta.checkpoints.join(', ')}`);
  lines.push('');
  lines.push('HONEST-NULL eval: measures whatever the numbers are; no tuning toward a positive result.');
  lines.push('');
  for (const cp of meta.checkpoints) {
    const a = agg[cp];
    if (!a) continue;
    lines.push(`## Checkpoint ${cp} (${CHECKPOINT_COUNTS[cp]} memories, ${a.seeds} seeds)`);
    lines.push('');
    lines.push(`Merge fired: mean ${a.meanMerged.toFixed(1)} episodics merged, ${a.meanSemanticCreated.toFixed(1)} summaries created. Budget-binding fit fraction (naive): ${fmtPct(a.meanFitFraction)}.`);
    lines.push('');
    lines.push('| Condition | QA accuracy | Mean active-context tokens |');
    lines.push('|---|---|---|');
    for (const cond of CONDITIONS) {
      lines.push(`| ${cond} | ${fmtPct(a.qa[cond])} | ${a.tokens[cond].toFixed(0)} |`);
    }
    lines.push('');
    const d1 = a.deltas['hippo-full_vs_hippo-no-lifecycle'];
    const d2 = a.deltas['hippo-full_vs_naive-append'];
    lines.push('Paired QA deltas (95% bootstrap CI):');
    lines.push(`- hippo-full vs hippo-no-lifecycle: ${sign(d1.meanDiff)}${(100 * d1.meanDiff).toFixed(1)} pp [${(100 * d1.low).toFixed(1)}, ${(100 * d1.high).toFixed(1)}] pp`);
    lines.push(`- hippo-full vs naive-append: ${sign(d2.meanDiff)}${(100 * d2.meanDiff).toFixed(1)} pp [${(100 * d2.low).toFixed(1)}, ${(100 * d2.high).toFixed(1)}] pp`);
    const d3 = a.deltas['hippo-full-strength_vs_hippo-no-lifecycle-strength'];
    lines.push(`- hippo-full vs hippo-no-lifecycle (strength-sorted ambient assembly): ${sign(d3.meanDiff)}${(100 * d3.meanDiff).toFixed(1)} pp [${(100 * d3.low).toFixed(1)}, ${(100 * d3.high).toFixed(1)}] pp`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!isEmbeddingAvailable()) {
    console.error('NO_EMBEDDINGS - local embedding model unavailable; cannot run the physics path.');
    process.exit(2);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is set; this harness must run hermetically. Unset it and re-run.');
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const meta = {
    budget: BUDGET, facts: NUM_FACTS, dupes: DUPES,
    seeds: NUM_SEEDS, checkpoints: CHECKPOINTS,
  };
  console.error(`Lifecycle stress eval | ${JSON.stringify(meta)}`);

  const cells = [];
  const t0 = Date.now();
  for (const cp of CHECKPOINTS) {
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = 1000 + s; // recorded, paired across conditions
      const cell = await runCell(seed, cp);
      cells.push(cell);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.error(`  [${cp} seed ${seed}] merged=${cell.merged} sem=${cell.semanticCreated} ` +
        `qa full=${fmtPct(cell.qa['hippo-full'])} noLife=${fmtPct(cell.qa['hippo-no-lifecycle'])} ` +
        `naive=${fmtPct(cell.qa['naive-append'])} (${elapsed}s)`);
    }
  }

  const agg = aggregate(cells);
  const results = {
    meta: { ...meta, generatedAt: new Date().toISOString(), checkpointCounts: CHECKPOINT_COUNTS, honestNull: true },
    perCheckpoint: agg,
    cells,
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(OUT_DIR, `results-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'results-latest.json'), JSON.stringify(results, null, 2));

  const md = printMarkdown(agg, meta);
  console.log('');
  console.log(md);
  console.error(`\nResults JSON: ${jsonPath}`);
}

main().catch((err) => { console.error('FATAL', err); process.exit(1); });
