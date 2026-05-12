#!/usr/bin/env node
/**
 * F13: turn-level retrieval with max-pool aggregation to session.
 *
 * Reads:
 *   - data/longmemeval_oracle.json (500 questions)
 *   - benchmarks/longmemeval/data/turn_index_e5.json (turn vectors from chunk_per_turn_embed.mjs)
 *
 * For each question:
 *   1. Embed the query with `query: <text>` via multilingual-e5-large.
 *   2. Compute cosine similarity against every turn vector (vectors are L2-normalized,
 *      so cosine = dot product).
 *   3. Group by `session_id`, take the max score per session.
 *   4. Output the top-K sessions, each tagged with its session_id so the existing
 *      `evaluate_retrieval.py` matches `answer_session_ids` against the `tags` field.
 *
 * Writes a JSONL compatible with benchmarks/longmemeval/evaluate_retrieval.py.
 *
 * Set HIPPO_MODEL_CACHE before running.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const INDEX = process.argv[2] || 'benchmarks/longmemeval/data/turn_index_e5.json';
const OUT = process.argv[3] || 'results/f13_baseline/turn_top100.jsonl';
const TOP_K = parseInt(process.argv[4] || '100', 10);
const DATA = process.argv[5] || 'data/longmemeval_oracle.json';

if (!process.env.HIPPO_MODEL_CACHE) {
  process.env.HIPPO_MODEL_CACHE = resolve('benchmarks/longmemeval/data/model-cache');
}

const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = process.env.HIPPO_MODEL_CACHE;
env.localModelPath = process.env.HIPPO_MODEL_CACHE;
env.allowRemoteModels = false;

console.log(`[F13r] loading turn index from ${INDEX}...`);

// Auto-detect JSONL vs legacy single-blob JSON. JSONL is the v1.9.3+ format
// (one turn per line; first line is metadata). Legacy is one big JSON object.
function isJsonlPath(p) {
  return p.endsWith('.jsonl') || p.endsWith('.jsonl.partial') || existsSync(p + '.jsonl') || existsSync(p);
}

// If user passed the .json (legacy) path but a .jsonl sibling exists, prefer it.
let effectiveIndex = INDEX;
if (!INDEX.endsWith('.jsonl') && existsSync(INDEX + '.jsonl')) {
  effectiveIndex = INDEX + '.jsonl';
  console.log(`[F13r] using JSONL sibling: ${effectiveIndex}`);
}

let MODEL = null;
let stagedSessionIds = [];
let stagedTurnIdxs = [];
let stagedContents = [];
let stagedVecs = []; // each entry is a Float32Array view of one row

if (effectiveIndex.endsWith('.jsonl')) {
  const rl = createInterface({ input: createReadStream(effectiveIndex), crlfDelay: Infinity });
  let dim = 0;
  for await (const line of rl) {
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (t._meta) {
      MODEL = t._meta.model;
      if (t._meta.dim) dim = t._meta.dim;
      continue;
    }
    if (!t.vec || !Array.isArray(t.vec)) continue;
    if (!dim) dim = t.vec.length;
    stagedSessionIds.push(t.session_id);
    stagedTurnIdxs.push(t.turn_idx);
    stagedContents.push(t.content);
    stagedVecs.push(new Float32Array(t.vec));
  }
  // MODEL may not have been set if metadata line is missing (legacy partial migration).
  // Recover from the embed-script convention: BGE-base or e5-large default.
  if (!MODEL) {
    console.error('[F13r] no _meta line found; refusing to guess model');
    process.exit(2);
  }
  console.log(`[F13r]   ${stagedSessionIds.length} turns, dim=${dim}, model=${MODEL}`);
  var N = stagedSessionIds.length;
  var D = dim;
  var mat = new Float32Array(N * D);
  for (let i = 0; i < N; i++) {
    const v = stagedVecs[i];
    const off = i * D;
    for (let j = 0; j < D; j++) mat[off + j] = v[j];
  }
  stagedVecs = null; // release
  var sessionIds = stagedSessionIds;
  var turnIdxs = stagedTurnIdxs;
  var contents = stagedContents;
} else {
  const idx = JSON.parse(readFileSync(effectiveIndex, 'utf8'));
  console.log(`[F13r]   ${idx.count} turns, dim=${idx.dim}, model=${idx.model}`);
  MODEL = idx.model;
  var N = idx.count;
  var D = idx.dim;
  var mat = new Float32Array(N * D);
  var sessionIds = new Array(N);
  var turnIdxs = new Array(N);
  var contents = new Array(N);
  for (let i = 0; i < N; i++) {
    const t = idx.turns[i];
    sessionIds[i] = t.session_id;
    turnIdxs[i] = t.turn_idx;
    contents[i] = t.content;
    const off = i * D;
    for (let j = 0; j < D; j++) mat[off + j] = t.vec[j];
  }
}

const IS_E5 = /\be5\b/i.test(MODEL);
const IS_BGE = /\bbge\b/i.test(MODEL);
const POOLING = IS_BGE ? 'cls' : 'mean';

console.log(`[F13r] index packed: ${(mat.byteLength / 1024 / 1024).toFixed(1)} MB`);

console.log(`[F13r] loading ${MODEL}...`);
const t0 = Date.now();
const pipe = await pipeline('feature-extraction', MODEL);
console.log(`[F13r] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const data = JSON.parse(readFileSync(DATA, 'utf8'));

mkdirSync(dirname(OUT), { recursive: true });
const outFp = OUT;
let outStream = [];

console.log(`[F13r] retrieving for ${data.length} questions (top ${TOP_K})...`);
const retT0 = Date.now();
let lastLog = retT0;
for (let qi = 0; qi < data.length; qi++) {
  const q = data[qi];
  const queryInput = IS_E5 ? `query: ${q.question}` : q.question;
  const qRes = await pipe(queryInput, { pooling: POOLING, normalize: true });
  const qv = new Float32Array(qRes.data);

  // Dot products against all turns. Since both sides L2-normed, dot == cosine.
  const turnScores = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    const off = i * D;
    for (let j = 0; j < D; j++) s += mat[off + j] * qv[j];
    turnScores[i] = s;
  }

  // Aggregate to session: max score per session, remember which turn produced it.
  const sessMaxScore = new Map();   // session_id -> max score
  const sessBestTurn = new Map();   // session_id -> turn array index (for content)
  for (let i = 0; i < N; i++) {
    const sid = sessionIds[i];
    const s = turnScores[i];
    const prev = sessMaxScore.get(sid);
    if (prev === undefined || s > prev) {
      sessMaxScore.set(sid, s);
      sessBestTurn.set(sid, i);
    }
  }

  // Sort sessions descending, take top-K.
  const sortedSids = [...sessMaxScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_K);

  // Build retrieved_memories: one entry per session, tagged with session_id.
  const mems = sortedSids.map(([sid, score]) => {
    const turnI = sessBestTurn.get(sid);
    return {
      id: `turn_${sid}_${turnIdxs[turnI]}`,
      score,
      strength: 1.0,
      tags: [sid],          // critical for evaluate_retrieval.py — matches answer_session_ids
      content: contents[turnI],
      tokens: Math.ceil(contents[turnI].length / 4),
    };
  });

  outStream.push(JSON.stringify({
    question_id: q.question_id,
    question: q.question,
    answer: q.answer,
    question_type: q.question_type,
    question_date: q.question_date,
    retrieved_memories: mems,
    num_retrieved: mems.length,
  }));

  const now = Date.now();
  if (now - lastLog > 10_000 || qi === data.length - 1) {
    const rate = (qi + 1) / ((now - retT0) / 1000);
    const eta = (data.length - qi - 1) / rate;
    console.log(`[F13r] ${qi + 1}/${data.length}  ${rate.toFixed(2)}/s  ETA ${eta.toFixed(0)}s`);
    lastLog = now;
  }
}

writeFileSync(outFp, outStream.join('\n') + '\n');
const wall = ((Date.now() - retT0) / 1000);
console.log(`[F13r] retrieval wall: ${wall.toFixed(1)}s for ${data.length} queries`);
console.log(`[F13r] wrote ${outFp}`);
