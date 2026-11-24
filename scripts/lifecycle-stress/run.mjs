#!/usr/bin/env node

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemory } from '../../dist/entry/memory.js';
import { initStore, loadAllEntries, loadEmbeddingIndex } from '../../dist/entry/testing.js';
import { embedMemory } from '../../dist/entry/testing.js';
import { isEmbeddingAvailable } from '../../dist/base/embeddings/local.js';
import { physicsSearch } from '../../dist/entry/store-kit.js';
import { consolidate } from '../../dist/index.js';
import { resetAllPhysicsState } from '../../dist/db/physics-state.js';
import { openHippoDb, closeHippoDb, withSharedStoreHandles } from '../../dist/db/index.js';
import { writeEntryIn } from '../../dist/store/sqlite/fixtures.js';
import { storeFilesOf } from '../../dist/store/sqlite/runtime/handles.js';
import { DEFAULT_PHYSICS_CONFIG } from '../../dist/base/rank/physics-config.js';

import { injectStream, writeLabelSidecar } from './inject.mjs';
import { mulberry32 } from '../lib/prng.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(REPO, 'benchmarks', 'lifecycle-stress');

const CHECKPOINT_COUNTS = { '1x': 100, '10x': 1000, '100x': 10000 };

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const CHECKPOINTS = flag('--checkpoints', '1x,10x,100x')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const NUM_SEEDS = parseInt(flag('--seeds', '20'), 10);
const NUM_FACTS = parseInt(flag('--facts', '6'), 10);
const DUPES = parseInt(flag('--dupes', '3'), 10);
const BUDGET = parseInt(flag('--budget', '1500'), 10);

for (const cp of CHECKPOINTS) {
  if (!(cp in CHECKPOINT_COUNTS)) {
    console.error(`Unknown checkpoint "${cp}". Known: ${Object.keys(CHECKPOINT_COUNTS).join(', ')}`);
    process.exit(2);
  }
}

const PC = { ...DEFAULT_PHYSICS_CONFIG, enabled: true };
const tok = (s) => Math.ceil((s || '').length / 4);

/** @param {number[]} diffs @returns {{meanDiff:number, low:number, high:number}} */
function pairedBootstrapCI(diffs, iters = 10000, alpha = 0.05) {
  const n = diffs.length;
  if (n === 0) return { meanDiff: 0, low: 0, high: 0 };
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const rng = mulberry32(0x9e3779b9);
  const boots = Array(iters);
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

async function buildStore(memories) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-lse-'));
  const root = path.join(base, '.hippo');
  initStore(root);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ replay: { count: 0 } }, null, 2));
  const createdOrder = [];
  // One connection for the seed loop: a close per write checkpoints the WAL, which is slow on Windows.
  await withSharedStoreHandles((session) => {
    const files = storeFilesOf(root, { session });
    for (const m of memories) {
      const e = createMemory(m.content, { tags: m.tags, source: 'lse' });
      writeEntryIn(files, e);
      createdOrder.push(e.id);
    }
  });
  for (const e of loadAllEntries(root)) await embedMemory(root, e);
  return { base, root, createdOrder };
}

async function reEmbed(root) {
  for (const e of loadAllEntries(root)) await embedMemory(root, e);
  const entries = loadAllEntries(root);
  const index = loadEmbeddingIndex(root);
  const db = openHippoDb(root);
  try {
    resetAllPhysicsState(db, entries, index);
  } finally {
    closeHippoDb(db);
  }
}

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

function naiveAssemble(entries, createdOrder, B) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newestFirst = [...createdOrder]
    .reverse()
    .map((id) => byId.get(id))
    .filter(Boolean);
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

function strengthSortedAssemble(entries, B) {
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sKey = (e) => Math.round((e.strength || 0) * 1000);
  const sorted = [...entries].sort((a, b) => sKey(b) - sKey(a) || cmp(a.content || '', b.content || ''));
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

async function recencyWindowAssemble(entries, createdOrder, B, labels, root) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const newestFirst = [...createdOrder]
    .reverse()
    .map((id) => byId.get(id))
    .filter(Boolean);
  const window = [];
  let used = 0;
  for (const e of newestFirst) {
    used += tok(e.content);
    window.push(e);
    if (used >= 2 * B) break;
  }
  return unionPerFact(window, B, labels, root);
}

async function unionPerFact(entries, B, labels, root) {
  const seen = new Map();
  for (const lab of labels) {
    const res = await physicsSearch(lab.topic, entries, {
      hippoRoot: root,
      physicsConfig: PC,
      budget: B,
      minResults: 1,
    });
    for (let i = 0; i < res.length; i++) {
      const id = res[i].entry.id;
      if (!seen.has(id) || i < seen.get(id).bestRank) {
        seen.set(id, { entry: res[i].entry, bestRank: i });
      }
    }
  }
  // Global fixed-budget repack: pack the per-fact union into a SINGLE budget B
  const ranked = [...seen.values()].sort((a, b) => a.bestRank - b.bestRank);
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

async function runCell(seed, checkpoint) {
  const scaleMemories = CHECKPOINT_COUNTS[checkpoint];
  const { memories, labels } = injectStream({
    seed,
    scaleMemories,
    numFacts: NUM_FACTS,
    dupesPerFact: DUPES,
  });
  writeLabelSidecar(
    path.join(OUT_DIR, 'labels'),
    { seed, scaleMemories, numFacts: NUM_FACTS, dupesPerFact: DUPES },
    labels,
  );

  const A = await buildStore(memories);
  const entriesA = loadAllEntries(A.root);

  const naive = scoreAssembled(naiveAssemble(entriesA, A.createdOrder, BUDGET), labels);
  const recency = scoreAssembled(await recencyWindowAssemble(entriesA, A.createdOrder, BUDGET, labels, A.root), labels);
  const noLife = scoreAssembled(await unionPerFact(entriesA, BUDGET, labels, A.root), labels);

  const B = await buildStore(memories);
  const cons = await consolidate(B.root, {});
  await reEmbed(B.root);
  const entriesB = loadAllEntries(B.root);
  const full = scoreAssembled(await unionPerFact(entriesB, BUDGET, labels, B.root), labels);

  const noLifeSS = scoreAssembled(strengthSortedAssemble(entriesA, BUDGET), labels);
  const fullSS = scoreAssembled(strengthSortedAssemble(entriesB, BUDGET), labels);

  const totalTokens = memories.reduce((s, m) => s + tok(m.content), 0);
  const fitFraction = Math.min(1, BUDGET / Math.max(1, totalTokens));

  fs.rmSync(A.base, { recursive: true, force: true });
  fs.rmSync(B.base, { recursive: true, force: true });

  const m = NUM_FACTS;
  return {
    seed,
    checkpoint,
    scaleMemories,
    facts: m,
    merged: cons.merged,
    semanticCreated: cons.semanticCreated,
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

const CONDITIONS = [
  'naive-append',
  'recency-window',
  'hippo-no-lifecycle',
  'hippo-full',
  'hippo-no-lifecycle-strength',
  'hippo-full-strength',
];

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function fmtPct(x) {
  return (100 * x).toFixed(1) + '%';
}
function sign(x) {
  return x >= 0 ? '+' : '';
}

function aggregate(cells) {
  const byCp = new Map();
  for (const c of cells) {
    if (!byCp.has(c.checkpoint)) byCp.set(c.checkpoint, []);
    byCp.get(c.checkpoint).push(c);
  }
  const perCheckpoint = {};
  for (const [cp, rows] of byCp) {
    const qa = {},
      tokens = {};
    for (const cond of CONDITIONS) {
      qa[cond] = mean(rows.map((r) => r.qa[cond]));
      tokens[cond] = mean(rows.map((r) => r.tokens[cond]));
    }
    const sorted = [...rows].sort((a, b) => a.seed - b.seed);
    const dFullVsNoLife = sorted.map((r) => r.qa['hippo-full'] - r.qa['hippo-no-lifecycle']);
    const dFullVsNaive = sorted.map((r) => r.qa['hippo-full'] - r.qa['naive-append']);
    const dFullVsNoLifeSS = sorted.map((r) => r.qa['hippo-full-strength'] - r.qa['hippo-no-lifecycle-strength']);
    perCheckpoint[cp] = {
      seeds: rows.length,
      meanMerged: mean(rows.map((r) => r.merged)),
      meanSemanticCreated: mean(rows.map((r) => r.semanticCreated)),
      meanFitFraction: mean(rows.map((r) => r.fitFraction)),
      qa,
      tokens,
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
  lines.push(
    `Budget B: ${meta.budget} tokens | facts: ${meta.facts} | dupes/fact: ${meta.dupes} | seeds: ${meta.seeds} | checkpoints: ${meta.checkpoints.join(', ')}`,
  );
  lines.push('');
  lines.push('HONEST-NULL eval: measures whatever the numbers are; no tuning toward a positive result.');
  lines.push('');
  for (const cp of meta.checkpoints) {
    const a = agg[cp];
    if (!a) continue;
    lines.push(`## Checkpoint ${cp} (${CHECKPOINT_COUNTS[cp]} memories, ${a.seeds} seeds)`);
    lines.push('');
    lines.push(
      `Merge fired: mean ${a.meanMerged.toFixed(1)} episodics merged, ${a.meanSemanticCreated.toFixed(1)} summaries created. Budget-binding fit fraction (naive): ${fmtPct(a.meanFitFraction)}.`,
    );
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
    lines.push(
      `- hippo-full vs hippo-no-lifecycle: ${sign(d1.meanDiff)}${(100 * d1.meanDiff).toFixed(1)} pp [${(100 * d1.low).toFixed(1)}, ${(100 * d1.high).toFixed(1)}] pp`,
    );
    lines.push(
      `- hippo-full vs naive-append: ${sign(d2.meanDiff)}${(100 * d2.meanDiff).toFixed(1)} pp [${(100 * d2.low).toFixed(1)}, ${(100 * d2.high).toFixed(1)}] pp`,
    );
    const d3 = a.deltas['hippo-full-strength_vs_hippo-no-lifecycle-strength'];
    lines.push(
      `- hippo-full vs hippo-no-lifecycle (strength-sorted ambient assembly): ${sign(d3.meanDiff)}${(100 * d3.meanDiff).toFixed(1)} pp [${(100 * d3.low).toFixed(1)}, ${(100 * d3.high).toFixed(1)}] pp`,
    );
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  if (!isEmbeddingAvailable()) {
    console.error('NO_EMBEDDINGS - local embedding model unavailable; cannot run the physics path.');
    process.exit(2);
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.HIPPO_LLM_BASE_URL) {
    console.error(
      'ANTHROPIC_API_KEY or HIPPO_LLM_BASE_URL is set; this harness must run hermetically. Unset both and re-run.',
    );
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const meta = {
    budget: BUDGET,
    facts: NUM_FACTS,
    dupes: DUPES,
    seeds: NUM_SEEDS,
    checkpoints: CHECKPOINTS,
  };
  console.error(`Lifecycle stress eval | ${JSON.stringify(meta)}`);

  const cells = [];
  const t0 = Date.now();
  for (const cp of CHECKPOINTS) {
    for (let s = 0; s < NUM_SEEDS; s++) {
      const seed = 1000 + s;
      const cell = await runCell(seed, cp);
      cells.push(cell);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.error(
        `  [${cp} seed ${seed}] merged=${cell.merged} sem=${cell.semanticCreated} ` +
          `qa full=${fmtPct(cell.qa['hippo-full'])} noLife=${fmtPct(cell.qa['hippo-no-lifecycle'])} ` +
          `naive=${fmtPct(cell.qa['naive-append'])} (${elapsed}s)`,
      );
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

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
