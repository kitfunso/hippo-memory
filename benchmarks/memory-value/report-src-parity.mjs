#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG } from './config.mjs';
import { evaluateStore, evaluateAll } from './evaluate.mjs';
import {
  readJson,
  scratchRootDir,
  hippoRootFor,
  questionDir,
  metaPathFor,
  goldPathFor,
} from './common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, '..', '..');
const SPLIT_REGISTERED_PATH = path.join(HERE, 'split-registered.json');

let loadAllEntries;
let scoreEntries;

const BUDGET = 0.3;
const EPS = 5e-5;
const REGISTERED_WEIGHTED = 0.48973684210526314;
const REGISTERED_RECENCY = 0.42026315789473684;
const CARRIER_DIM = 'age_days';

class GateGuardError extends Error {}

function guard(cond, message) {
  if (!cond) throw new GateGuardError(message);
}

const DIST_MEMORY_VALUE_PATH = path.join(REPO_ROOT, 'dist', 'domain/consolidate/memory-value.js');
const DIST_STORE_PATH = path.join(REPO_ROOT, 'dist', 'entry', 'testing.js');
const SRC_WATCH_PATHS = [
  path.join(REPO_ROOT, 'src', 'domain/consolidate/memory-value.ts'),
  path.join(REPO_ROOT, 'src', 'domain/consolidate/memory-value-weights.ts'),
];

function assertDistFresh() {
  guard(
    fs.existsSync(DIST_MEMORY_VALUE_PATH),
    `dist/consolidate/memory-value.js not found (${DIST_MEMORY_VALUE_PATH}) — rebuild first: npm run build`,
  );
  const distMtimeMs = fs.statSync(DIST_MEMORY_VALUE_PATH).mtimeMs;
  for (const srcPath of SRC_WATCH_PATHS) {
    guard(fs.existsSync(srcPath), `expected src file missing: ${srcPath}`);
    const srcMtimeMs = fs.statSync(srcPath).mtimeMs;
    guard(
      srcMtimeMs <= distMtimeMs,
      `${path.relative(REPO_ROOT, srcPath)} is newer than dist/consolidate/memory-value.js — rebuild first: npm run build`,
    );
  }
}

/** Freshness-checks then dynamically imports the dist scorer modules,
 *  populating the module-level loadAllEntries/scoreEntries bindings. Must
 *  run (via main()) before srcWeightedRetentionForQuestion is called. */
export async function loadDistScorer() {
  assertDistFresh();
  const [storeMod, mvMod] = await Promise.all([
    import(pathToFileURL(DIST_STORE_PATH).href),
    import(pathToFileURL(DIST_MEMORY_VALUE_PATH).href),
  ]);
  loadAllEntries = storeMod.loadAllEntries;
  scoreEntries = mvMod.scoreEntries;
  return { loadAllEntries, scoreEntries };
}

/** Registered heldout ids, in registered order — the same source fit.mjs
 *  --report reads (split-registered.json). No extra filtering here beyond
 *  what evaluateStore/evaluateAll already apply via their own zero-gold
 *  skip (contract 1: same split source, same filters as the registered
 *  report). */
export function loadHeldoutIds() {
  guard(fs.existsSync(SPLIT_REGISTERED_PATH), `split-registered.json not found: ${SPLIT_REGISTERED_PATH}`);
  const split = readJson(SPLIT_REGISTERED_PATH);
  guard(Array.isArray(split.heldout) && split.heldout.length > 0, 'split-registered.json has no heldout id array');
  return split.heldout;
}

function assertQuestionStoreReady(id) {
  const root = scratchRootDir();
  guard(fs.existsSync(root), `scratch root does not exist: ${root}`);
  guard(fs.existsSync(questionDir(id)), `heldout question ${id} has no scratch dir under ${root}`);
  guard(
    fs.existsSync(hippoRootFor(id)),
    `heldout question ${id} has no store/ subdirectory (${hippoRootFor(id)}) — the real fit-time SQLite store is ` +
      "gone (likely cleaned up post-extraction); G1's primary path cannot run over it. Per the prereg fallback: " +
      'rebuild the heldout scratch (node benchmarks/memory-value/run.mjs --data <path>) or fall back to the ' +
      'composition argument and label the result "composed, not end-to-end".',
  );
}

/** Per-question src-weighted retention at BUDGET: fresh entries from the
 *  real scratch store -> dist scoreEntries() (the src path under test) ->
 *  evaluateStore's OWN keep-selection via the carrier-dim technique above.
 *  Returns null on the zero-gold skip (mirrors evaluateStore's own
 *  retention:null contract — never counted, never dropped from the id list,
 *  matching evaluateAll's aggregate rule). */
export function srcWeightedRetentionForQuestion(id) {
  assertQuestionStoreReady(id);
  const meta = readJson(metaPathFor(id));
  guard(meta.tEval?.constructor === String && meta.tEval.length > 0, `question ${id} meta.json has no tEval`);
  const evalNow = new Date(meta.tEval);

  const gold = readJson(goldPathFor(id));
  const goldById = new Map(gold.memories.map((m) => [m.id, m.isGold]));
  const provenanceById = new Map(gold.memories.map((m) => [m.id, { sessionIndex: m.sessionIndex, turnIdx: m.turnIdx }]));

  const entries = loadAllEntries(hippoRootFor(id));
  const scores = scoreEntries(entries, evalNow);

  const rows = entries.map((e) => {
    const prov = provenanceById.get(e.id);
    guard(prov !== undefined, `question ${id}: no gold.json provenance for memory ${e.id}`);
    const features = {};
    for (const f of CONFIG.FEATURES) features[f] = 0;
    features[CARRIER_DIM] = scores.get(e.id);
    return {
      memory_id: e.id,
      sessionIndex: prov.sessionIndex,
      turnIdx: prov.turnIdx,
      gold: goldById.get(e.id) === true ? 1 : 0,
      features,
    };
  });

  const result = evaluateStore(rows, [BUDGET], { [CARRIER_DIM]: 1 });
  return result.perScorer.weighted[BUDGET].retention;
}

/** Mean over non-null per-question retentions, zero-gold skip (mirrors
 *  evaluateAll's own aggregate rule — see evaluate.mjs header comment). The
 *  only new arithmetic in this file, same class fit.mjs's own
 *  computeTrainObjective already permits itself for this harness (mean +
 *  zero-gold skip, never selection). */
export function meanWithZeroGoldSkip(values) {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (v === null) continue;
    sum += v;
    count++;
  }
  return { mean: count > 0 ? sum / count : null, count, skipped: values.length - count };
}

/** Recency baseline through evaluate.mjs's untouched normal path
 *  (evaluateAll reading features.jsonl) — a sanity cross-check independent
 *  of the store-loading / scoreEntries path under test above. */
export function recencyCrossCheck(ids) {
  const questionSplits = ids.map((questionId) => ({ questionId, split: 'heldout' }));
  const result = evaluateAll(questionSplits, { budgets: [BUDGET], primaryBudget: BUDGET });
  return result.summary.heldout.recency[BUDGET].meanRetention;
}

function parseArgs(argv) {
  const i = argv.indexOf('--slice');
  if (i < 0) return { sliceN: null };
  const sliceN = Number(argv[i + 1]);
  guard(Number.isInteger(sliceN) && sliceN >= 1, `--slice requires a positive integer, got ${argv[i + 1]}`);
  return { sliceN };
}

async function main() {
  guard(
    CONFIG.PRIMARY_BUDGET === BUDGET,
    `CONFIG.PRIMARY_BUDGET (${CONFIG.PRIMARY_BUDGET}) no longer matches this gate's hardcoded budget (${BUDGET}) — protocol drift`,
  );

  await loadDistScorer();

  const { sliceN } = parseArgs(process.argv.slice(2));
  const heldoutIds = loadHeldoutIds();
  const ids = sliceN ? heldoutIds.slice(0, sliceN) : heldoutIds;
  const isFull = ids.length === heldoutIds.length;

  const t0 = Date.now();
  const perQuestion = ids.map(srcWeightedRetentionForQuestion);
  const { mean: srcWeighted, count: srcCount } = meanWithZeroGoldSkip(perQuestion);
  const elapsedSec = (Date.now() - t0) / 1000;

  const recency = recencyCrossCheck(ids);

  const delta = isFull && srcWeighted !== null ? srcWeighted - REGISTERED_WEIGHTED : null;
  const recencyDelta = isFull && recency !== null ? recency - REGISTERED_RECENCY : null;
  const pass = isFull
    ? delta !== null && Math.abs(delta) < EPS && recencyDelta !== null && Math.abs(recencyDelta) < EPS
    : null;

  const verdict = {
    mode: isFull ? 'full' : `slice(${ids.length})`,
    questionsIncluded: srcCount,
    srcWeighted,
    registeredWeighted: isFull ? REGISTERED_WEIGHTED : null,
    delta,
    recencyCrossCheck: recency,
    registeredRecency: isFull ? REGISTERED_RECENCY : null,
    recencyDelta,
    elapsedSec,
    pass,
  };
  console.log(JSON.stringify(verdict, null, 2));
  if (isFull) process.exit(pass ? 0 : 1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await main();
  } catch (err) {
    if (err instanceof GateGuardError) {
      console.error(`[G1] FAILED (guard): ${err.message}`);
      process.exit(2);
    }
    console.error(`[G1] FAILED: ${err.stack ?? err.message}`);
    process.exit(2);
  }
}
