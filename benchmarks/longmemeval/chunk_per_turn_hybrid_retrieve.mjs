#!/usr/bin/env node
/**
 * F9 Task 2b — hybrid retrieve (BM25 + chunked-turn dense via RRF).
 *
 * Loads a turn-level dense index (from chunk_per_turn_embed.mjs) and a
 * BM25 corpus (from chunk_per_turn_bm25_index.mjs), runs both signals
 * over a LongMemEval source dataset, max-pools each to session, and
 * fuses the two session orderings via the shared `rrfFuse` helper from
 * src/rrf.ts.
 *
 * Usage:
 *   node benchmarks/longmemeval/chunk_per_turn_hybrid_retrieve.mjs \
 *     --turn-index <path> \
 *     --bm25 <path>  (turn-level OR session-level corpus JSON) \
 *     --data <path>  (LongMemEval source JSON) \
 *     --out <path>   (JSONL output) \
 *     [--rrf-weight-bm25 0.5] [--rrf-weight-dense 0.5] [--rrf-k 60] [--top-k 100] \
 *     [--questions <int>]  (limit to first N questions, for dry-run / smoke)
 *
 * The BM25 corpus's `_meta.level` field determines granularity (turn vs session)
 * and how max-pool aggregation works:
 *   - level=turn:    BM25 score per turn → max-pool to session, like the dense path.
 *   - level=session: BM25 score per session directly; no max-pool needed.
 *
 * Output: JSONL compatible with benchmarks/longmemeval/evaluate_retrieval.py.
 *
 * Plan + prereg: docs/plans/2026-05-20-f9-hybrid-retrieval-parity.md
 *                docs/evals/2026-05-20-f9-hybrid-rrf-prereg.md
 */

import { readFileSync, writeFileSync, mkdirSync, createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { tokenize } from '../../dist/src/search.js';
import { rrfFuse, RRF_K } from '../../dist/src/rrf.js';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { 'rrf-weight-bm25': 0.5, 'rrf-weight-dense': 0.5, 'rrf-k': RRF_K, 'top-k': 100 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      // boolean flag with no value follows
      if (['mock-dense'].includes(key)) {
        args[key] = true;
        continue;
      }
      const v = argv[i + 1];
      // numeric coerce for known float/int args
      if (['rrf-weight-bm25', 'rrf-weight-dense'].includes(key)) args[key] = parseFloat(v);
      else if (['rrf-k', 'top-k', 'questions'].includes(key)) args[key] = parseInt(v, 10);
      else args[key] = v;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

for (const required of ['turn-index', 'bm25', 'data', 'out']) {
  if (!args[required]) {
    console.error(`missing --${required}`);
    process.exit(2);
  }
}

console.log(`[f9-hybrid] config:`, {
  'turn-index': args['turn-index'],
  bm25: args.bm25,
  data: args.data,
  out: args.out,
  'rrf-weight-bm25': args['rrf-weight-bm25'],
  'rrf-weight-dense': args['rrf-weight-dense'],
  'rrf-k': args['rrf-k'],
  'top-k': args['top-k'],
  questions: args.questions ?? 'all',
});

// ---------------------------------------------------------------------------
// Load BM25 corpus
// ---------------------------------------------------------------------------

console.log(`[f9-hybrid] loading BM25 corpus from ${args.bm25}...`);
const bm25Json = JSON.parse(readFileSync(args.bm25, 'utf8'));
const bm25Level = bm25Json._meta.level; // 'turn' | 'session'
const bm25Docs = bm25Json.docs;          // string[][]
const bm25Ids = bm25Json.ids;            // [{session_id, turn_idx?}, ...]
const bm25Df = new Map(Object.entries(bm25Json.df).map(([k, v]) => [k, Number(v)]));
const bm25N = bm25Json._meta.N;
const bm25AvgLen = bm25Json._meta.avgLen;
console.log(`[f9-hybrid]   level=${bm25Level}, N=${bm25N}, avgLen=${bm25AvgLen.toFixed(2)}, vocab=${bm25Df.size}`);

// BM25 constants (must mirror src/search.ts:52-53 — the canonical hippo values).
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function bm25Score(docIdx, queryTerms) {
  const doc = bm25Docs[docIdx];
  const docLen = doc.length;
  if (docLen === 0) return 0;
  // term-frequency map for this doc
  const tf = new Map();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of queryTerms) {
    const f = tf.get(term) ?? 0;
    if (f === 0) continue;
    const df = bm25Df.get(term) ?? 0;
    const idf = Math.log((bm25N - df + 0.5) / (df + 0.5) + 1);
    const numer = f * (BM25_K1 + 1);
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / bm25AvgLen));
    score += idf * (numer / denom);
  }
  return score;
}

// ---------------------------------------------------------------------------
// Load turn-level dense index (JSONL only — F13+ format).
// ---------------------------------------------------------------------------

let denseModel = null;
const denseSessionIds = [];
const denseTurnIdxs = [];
const denseContents = [];
let denseMat = null;
let denseDim = 0;
let denseN = 0;

if (!args['mock-dense']) {
  console.log(`[f9-hybrid] loading dense turn index from ${args['turn-index']}...`);
  const denseVecs = [];

  const turnIndexPath = args['turn-index'];
  const rl = createInterface({ input: createReadStream(turnIndexPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (t._meta) {
      denseModel = t._meta.model;
      continue;
    }
    if (!t.vec || !Array.isArray(t.vec)) continue;
    denseSessionIds.push(t.session_id);
    denseTurnIdxs.push(t.turn_idx);
    denseContents.push(t.content);
    denseVecs.push(new Float32Array(t.vec));
  }
  if (!denseModel) {
    console.error('[f9-hybrid] dense index missing _meta line; refusing to guess model');
    process.exit(2);
  }
  denseN = denseVecs.length;
  denseDim = denseVecs[0]?.length ?? 0;
  console.log(`[f9-hybrid]   model=${denseModel}, turns=${denseN}, dim=${denseDim}`);

  // Pack into a flat matrix for fast dot products.
  denseMat = new Float32Array(denseN * denseDim);
  for (let i = 0; i < denseN; i++) {
    const v = denseVecs[i];
    const off = i * denseDim;
    for (let j = 0; j < denseDim; j++) denseMat[off + j] = v[j];
  }
} else {
  console.log(`[f9-hybrid] MOCK-DENSE mode: dense path uses deterministic stub.`);
  console.log(`[f9-hybrid]   This is a dry-run-only mode. NEVER use for Gate-B.`);
  // We need a list of session ids to rank against. Pull them from the BM25 corpus
  // (which has full session coverage). The mock dense ranking is deterministic
  // per query: reverse-alphabetical by session_id with a fixed offset rotation,
  // so it neither agrees with BM25 nor degenerates to a single trivial ordering.
  const uniqSessionIds = [...new Set(bm25Ids.map((x) => x.session_id))];
  console.log(`[f9-hybrid]   stub will rank over ${uniqSessionIds.length} session ids`);
  // We keep denseMat null to signal "use stub" in the per-query loop.
  // Mock dense scoring is implemented inline below.
  denseN = uniqSessionIds.length;
  denseModel = '__MOCK_DENSE_STUB__';
  // Populate denseSessionIds with the universe of sessions so the
  // "max-pool to session" reduction has the same data shape.
  for (const sid of uniqSessionIds) {
    denseSessionIds.push(sid);
    denseTurnIdxs.push(0);
    denseContents.push('');
  }
}

// ---------------------------------------------------------------------------
// Load embedder
// ---------------------------------------------------------------------------

let pipe = null;
let IS_E5 = false;
let IS_BGE = false;
let POOLING = 'mean';

if (!args['mock-dense']) {
  if (!process.env.HIPPO_MODEL_CACHE) {
    process.env.HIPPO_MODEL_CACHE = resolve('benchmarks/longmemeval/data/model-cache');
  }
  IS_E5 = /\be5\b/i.test(denseModel);
  IS_BGE = /\bbge\b/i.test(denseModel);
  POOLING = IS_BGE ? 'cls' : 'mean';

  console.log(`[f9-hybrid] loading embedder ${denseModel}...`);
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = process.env.HIPPO_MODEL_CACHE;
  env.localModelPath = process.env.HIPPO_MODEL_CACHE;
  env.allowRemoteModels = false;
  const t0 = Date.now();
  pipe = await pipeline('feature-extraction', denseModel);
  console.log(`[f9-hybrid]   loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Run queries
// ---------------------------------------------------------------------------

console.log(`[f9-hybrid] loading questions from ${args.data}...`);
const data = JSON.parse(readFileSync(args.data, 'utf8'));
const questions = args.questions ? data.slice(0, args.questions) : data;
console.log(`[f9-hybrid] questions: ${questions.length}`);

mkdirSync(dirname(args.out), { recursive: true });
const outLines = [];

const TOP_K = args['top-k'];
const RRF_K_USED = args['rrf-k'];
const W_BM25 = args['rrf-weight-bm25'];
const W_DENSE = args['rrf-weight-dense'];

const retT0 = Date.now();
let lastLog = retT0;

// Deterministic stub dense scoring for --mock-dense. Hash (query, session_id)
// → float in [0, 1]. Different queries get different rankings, but it's stable
// for a given (query, session_id) pair. Designed so the stub does NOT
// collide with BM25's ordering — we want the dry-run to prove RRF fuses
// two genuinely different signals.
function mockDenseScore(query, sessionId) {
  let h = 2166136261;
  const s = `${query}::${sessionId}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

for (let qi = 0; qi < questions.length; qi++) {
  const q = questions[qi];

  // ---- dense ----
  let denseSessionMax;
  if (args['mock-dense']) {
    denseSessionMax = new Map();
    for (let i = 0; i < denseN; i++) {
      const sid = denseSessionIds[i];
      const s = mockDenseScore(q.question, sid);
      denseSessionMax.set(sid, { score: s, bestTurnIdx: i });
    }
  } else {
    const queryInputDense = IS_E5 ? `query: ${q.question}` : q.question;
    const qRes = await pipe(queryInputDense, { pooling: POOLING, normalize: true });
    const qv = new Float32Array(qRes.data);

    // dot product against all turn vectors → per-turn score
    const denseTurnScores = new Float32Array(denseN);
    for (let i = 0; i < denseN; i++) {
      let s = 0;
      const off = i * denseDim;
      for (let j = 0; j < denseDim; j++) s += denseMat[off + j] * qv[j];
      denseTurnScores[i] = s;
    }
    // max-pool to session
    denseSessionMax = new Map(); // sid -> { score, bestTurnIdx }
    for (let i = 0; i < denseN; i++) {
      const sid = denseSessionIds[i];
      const s = denseTurnScores[i];
      const prev = denseSessionMax.get(sid);
      if (prev === undefined || s > prev.score) {
        denseSessionMax.set(sid, { score: s, bestTurnIdx: i });
      }
    }
  }
  // score desc -> session-id lexicographic tiebreak, so eval artifacts stop
  // encoding Map iteration / scan order at ties (T2, deterministic tie keys).
  const denseRanked = [...denseSessionMax.entries()].sort((a, b) => {
    const d = b[1].score - a[1].score;
    return d !== 0 ? d : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  });

  // ---- BM25 ----
  const qTerms = tokenize(q.question);
  let bm25SessionMax = new Map(); // sid -> { score, bestDocIdx }
  if (bm25Level === 'turn') {
    // per-turn score → max-pool to session
    for (let i = 0; i < bm25Ids.length; i++) {
      const s = bm25Score(i, qTerms);
      if (s <= 0) continue;
      const sid = bm25Ids[i].session_id;
      const prev = bm25SessionMax.get(sid);
      if (prev === undefined || s > prev.score) {
        bm25SessionMax.set(sid, { score: s, bestDocIdx: i });
      }
    }
  } else {
    // per-session BM25 directly
    for (let i = 0; i < bm25Ids.length; i++) {
      const s = bm25Score(i, qTerms);
      if (s <= 0) continue;
      const sid = bm25Ids[i].session_id;
      bm25SessionMax.set(sid, { score: s, bestDocIdx: i });
    }
  }
  // score desc -> session-id lexicographic tiebreak (same rationale as
  // denseRanked above).
  const bm25Ranked = [...bm25SessionMax.entries()].sort((a, b) => {
    const d = b[1].score - a[1].score;
    return d !== 0 ? d : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  });

  // ---- RRF fuse ----
  const bm25Sids = bm25Ranked.map(([sid]) => sid);
  const denseSids = denseRanked.map(([sid]) => sid);
  const fused = rrfFuse([bm25Sids, denseSids], [W_BM25, W_DENSE], { k: RRF_K_USED });

  // Sort fused by score descending, take top-K. score desc -> session-id
  // lexicographic tiebreak (same rationale as denseRanked/bm25Ranked above).
  const topSids = [...fused.entries()]
    .sort((a, b) => {
      const d = b[1] - a[1];
      return d !== 0 ? d : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    })
    .slice(0, TOP_K);

  // Build retrieved_memories. Each row tagged with the session_id so
  // evaluate_retrieval.py's matcher works against `answer_session_ids`.
  const mems = topSids.map(([sid, score]) => {
    // Pick a representative content snippet — prefer the best dense turn,
    // else the best BM25 doc, else empty.
    const denseInfo = denseSessionMax.get(sid);
    const bm25Info = bm25SessionMax.get(sid);
    let content = '';
    if (denseInfo) {
      content = denseContents[denseInfo.bestTurnIdx];
    } else if (bm25Info && bm25Level === 'turn') {
      // bm25Info.bestDocIdx indexes bm25Docs (tokenized). We don't preserve
      // the original turn text in the BM25 artifact, so fall through.
      content = '';
    }
    return {
      id: `hybrid_${sid}`,
      score,
      strength: 1.0,
      tags: [sid],
      content,
      tokens: Math.ceil(content.length / 4),
      // F9 diagnostics: per-signal ranks for the dry-run gate analysis.
      _bm25_rank: bm25Sids.indexOf(sid) >= 0 ? bm25Sids.indexOf(sid) + 1 : null,
      _dense_rank: denseSids.indexOf(sid) >= 0 ? denseSids.indexOf(sid) + 1 : null,
      _bm25_score: bm25Info?.score ?? null,
      _dense_score: denseInfo?.score ?? null,
    };
  });

  outLines.push(JSON.stringify({
    question_id: q.question_id,
    question: q.question,
    answer: q.answer,
    question_type: q.question_type,
    question_date: q.question_date,
    retrieved_memories: mems,
    num_retrieved: mems.length,
  }));

  const now = Date.now();
  if (now - lastLog > 10_000 || qi === questions.length - 1) {
    const rate = (qi + 1) / ((now - retT0) / 1000);
    const eta = (questions.length - qi - 1) / rate;
    console.log(`[f9-hybrid] ${qi + 1}/${questions.length}  ${rate.toFixed(2)}/s  ETA ${eta.toFixed(0)}s`);
    lastLog = now;
  }
}

writeFileSync(args.out, outLines.join('\n') + '\n');
console.log(`[f9-hybrid] wrote ${args.out}`);
console.log(`[f9-hybrid] wall: ${((Date.now() - retT0) / 1000).toFixed(1)}s`);
