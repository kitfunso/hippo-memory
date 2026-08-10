#!/usr/bin/env node
/**
 * G1 gate adapter — LC2-E3 (docs/evals/2026-08-10-lc2-e3-wiring-prereg.md).
 *
 * Proves the COMPILED src scorer (dist/memory-value.js, built from
 * src/memory-value.ts) reproduces the registered E2 held-out weighted
 * retention through the harness's OWN evaluation (evaluate.mjs), over the
 * real fit-time scratch stores — NOT a re-derivation from features.jsonl.
 *
 * Eval-only. Read-only against the scratch stores. Never commits. Never
 * calls rescueSet (production-only rescue semantics) — this file only
 * exercises scoreEntries, the plain scoring function.
 *
 * ---------------------------------------------------------------------
 * Carrier-dim technique (why this never reimplements evaluate.mjs's
 * selection/tie-break/retention math):
 *
 * evaluate.mjs's evaluateStore() owns the ONLY sort/slice/tie-break/
 * retention code this harness trusts (buildScorers + the (score DESC,
 * sessionIndex ASC, turnIdx ASC, memory_id ASC) comparator + the keepN
 * slice + retention = keptGold/goldCount). This file must reuse that code
 * verbatim, not copy it — but evaluateStore always computes its OWN score
 * from raw feature values; it has no "take these precomputed scores" entry
 * point.
 *
 * Fix: feed the dist-computed score (scoreEntries's output — the src path
 * under test) into evaluateStore as the RAW value of one CONFIG.FEATURES
 * dim (age_days, arbitrary choice), with that dim's weight = 1 and every
 * other dim held at a literal constant (0) across the store so it
 * normalizes to 0 and contributes 0 regardless of weight. evaluateStore's
 * min-max normalization, norm(v) = (v-min)/(max-min), is a strictly
 * increasing affine function of v when max>min: it can never change the
 * DESC rank order of the carrier dim, and two equal raw scores map to the
 * exact same normalized value (same float in, same float out) — so both
 * the top-N cut and every tie are byte-identical to sorting on the raw
 * dist score directly. When max===min (every entry scored identically),
 * evaluateStore's own dead-feature rule (normalize to 0 for everyone)
 * still leaves every entry tied at 0 — the same "everybody ties" outcome
 * raw-score equality would also produce. Either way, evaluateStore's real
 * sort/slice/tie-break/retention code runs unmodified on a value that
 * ranks identically to the dist score. See the prereg's G1 "Dim
 * equivalence" note for the sibling argument (8-dim src scorer == 30-dim
 * harness scorer "by construction").
 * ---------------------------------------------------------------------
 *
 * Guards (read-only, no network):
 *   - scratch root missing, or a heldout question's store dir absent -> exit 2
 *   - CONFIG.PRIMARY_BUDGET != this gate's 0.30 -> exit 2 (protocol drift)
 *   - any other data-integrity failure (bad meta.json, missing provenance,
 *     malformed --slice) -> exit 2, never a raw unnamed crash
 *
 * Usage:
 *   node report-src-parity.mjs             full heldout gate (200 q); prints
 *                                           the verdict JSON, exit 0 on pass
 *                                           / 1 on fail
 *   node report-src-parity.mjs --slice 10  first 10 heldout ids only (registered
 *                                           order) — adapter smoke test, no
 *                                           pass/fail claim against the
 *                                           registered constants; always exit 0
 *                                           unless a guard fires
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { loadAllEntries } from '../../dist/store.js';
import { scoreEntries } from '../../dist/memory-value.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPLIT_REGISTERED_PATH = path.join(HERE, 'split-registered.json');

const BUDGET = 0.3; // G1's keep budget (== CONFIG.PRIMARY_BUDGET, asserted in main())
const EPS = 5e-5; // matches fit.mjs's own reproduction epsilon (half-ULP-at-4dp)
const REGISTERED_WEIGHTED = 0.48973684210526314; // fit-report-registered.json heldout.weighted
const REGISTERED_RECENCY = 0.42026315789473684; // fit-report-registered.json heldout.recency

// Carrier dim for the technique documented above. Any CONFIG.FEATURES member
// works; age_days is chosen for no reason beyond being first in FIT_DIMS.
const CARRIER_DIM = 'age_days';

class GateGuardError extends Error {}

function guard(cond, message) {
  if (!cond) throw new GateGuardError(message);
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
  guard(typeof meta.tEval === 'string' && meta.tEval.length > 0, `question ${id} meta.json has no tEval`);
  const evalNow = new Date(meta.tEval); // per-question causal clock clamp — see ingest.mjs header; NEVER wall-clock now

  const gold = readJson(goldPathFor(id));
  const goldById = new Map(gold.memories.map((m) => [m.id, m.isGold]));
  const provenanceById = new Map(gold.memories.map((m) => [m.id, { sessionIndex: m.sessionIndex, turnIdx: m.turnIdx }]));

  const entries = loadAllEntries(hippoRootFor(id)); // same loader extract.mjs uses for feature extraction
  const scores = scoreEntries(entries, evalNow); // dist src path under test — the thing G1 is proving

  const rows = entries.map((e) => {
    const prov = provenanceById.get(e.id);
    guard(prov !== undefined, `question ${id}: no gold.json provenance for memory ${e.id}`);
    const features = {};
    for (const f of CONFIG.FEATURES) features[f] = 0; // constant across the store -> normalizes to 0, weight-inert
    features[CARRIER_DIM] = scores.get(e.id);
    return {
      memory_id: e.id,
      sessionIndex: prov.sessionIndex,
      turnIdx: prov.turnIdx,
      gold: goldById.get(e.id) === true ? 1 : 0,
      features,
    };
  });

  const result = evaluateStore(rows, [BUDGET], { [CARRIER_DIM]: 1 }); // real, unmodified selection/tie-break/retention
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

function main() {
  guard(
    CONFIG.PRIMARY_BUDGET === BUDGET,
    `CONFIG.PRIMARY_BUDGET (${CONFIG.PRIMARY_BUDGET}) no longer matches this gate's hardcoded budget (${BUDGET}) — protocol drift`,
  );

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
    : null; // slice runs never claim pass/fail against the registered constants (different sample size)

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
    main();
  } catch (err) {
    if (err instanceof GateGuardError) {
      console.error(`[G1] FAILED (guard): ${err.message}`);
      process.exit(2);
    }
    console.error(`[G1] FAILED: ${err.stack ?? err.message}`);
    process.exit(2);
  }
}
