#!/usr/bin/env node
/**
 * F13: turn-level e5-large embedding for LongMemEval oracle.
 *
 * Reads data/longmemeval_oracle.json, extracts every distinct turn across all
 * 940 sessions, embeds each with `passage: <content>` via multilingual-e5-large,
 * and writes a turn-index JSON to disk.
 *
 * Output format (gitignored artifact at benchmarks/longmemeval/data/turn_index_e5.json):
 *   {
 *     "model": "Xenova/multilingual-e5-large",
 *     "dim": 1024,
 *     "turns": [
 *       { "session_id": "...", "turn_idx": 0, "role": "user"|"assistant", "content": "...", "vec": [...1024 floats...] },
 *       ...
 *     ]
 *   }
 *
 * Dedupe: a (session_id, turn_idx) tuple is unique per turn. Two questions
 * sharing the same session_id contribute the same turn rows; we keep one
 * physical embedding per unique (session_id, turn_idx).
 *
 * Cost: ~11k turns × ~150-300 ms inference = 30-60 min wall time.
 * Set HIPPO_MODEL_CACHE=$(pwd)/benchmarks/longmemeval/data/model-cache before running.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DATA = 'data/longmemeval_oracle.json';
const MODEL = process.argv[2] || 'Xenova/multilingual-e5-large';
const OUT = process.argv[3] || (
  MODEL.includes('bge') ? 'benchmarks/longmemeval/data/turn_index_bge.json' :
  'benchmarks/longmemeval/data/turn_index_e5.json'
);
const IS_E5 = /\be5\b/i.test(MODEL);
const IS_BGE = /\bbge\b/i.test(MODEL);
const POOLING = IS_BGE ? 'cls' : 'mean';

if (!process.env.HIPPO_MODEL_CACHE) {
  process.env.HIPPO_MODEL_CACHE = resolve('benchmarks/longmemeval/data/model-cache');
}

// Use the @huggingface/transformers backend that F12 wired in (it handles
// external-data ONNX correctly, which @xenova/transformers v2 does not).
const { pipeline, env } = await import('@huggingface/transformers');
env.cacheDir = process.env.HIPPO_MODEL_CACHE;
env.localModelPath = process.env.HIPPO_MODEL_CACHE;
env.allowRemoteModels = false;

console.log(`[F13] loading ${MODEL}...`);
const t0 = Date.now();
const pipe = await pipeline('feature-extraction', MODEL);
console.log(`[F13] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const data = JSON.parse(readFileSync(DATA, 'utf8'));

// Build a unique map keyed by (session_id, turn_idx)
const uniq = new Map();
for (const q of data) {
  for (let si = 0; si < q.haystack_session_ids.length; si++) {
    const sid = q.haystack_session_ids[si];
    const sess = q.haystack_sessions[si];
    for (let ti = 0; ti < sess.length; ti++) {
      const t = sess[ti];
      const key = `${sid}|${ti}`;
      if (!uniq.has(key)) {
        uniq.set(key, { session_id: sid, turn_idx: ti, role: t.role, content: t.content });
      }
    }
  }
}

const turns = [...uniq.values()];
console.log(`[F13] unique turns to embed: ${turns.length}`);
console.log(`[F13] unique sessions:        ${new Set(turns.map(t => t.session_id)).size}`);

mkdirSync(dirname(OUT), { recursive: true });

const embedT0 = Date.now();
const out = [];
let lastLog = embedT0;
for (let i = 0; i < turns.length; i++) {
  const t = turns[i];
  const input = IS_E5 ? `passage: ${t.content}` : t.content;
  const res = await pipe(input, { pooling: POOLING, normalize: true });
  out.push({
    session_id: t.session_id,
    turn_idx: t.turn_idx,
    role: t.role,
    content: t.content,
    vec: Array.from(res.data),
  });
  const now = Date.now();
  if (now - lastLog > 5_000 || i === turns.length - 1) {
    const rate = (i + 1) / ((now - embedT0) / 1000);
    const eta = (turns.length - i - 1) / rate;
    console.log(`[F13] ${i + 1}/${turns.length}  ${rate.toFixed(2)}/s  ETA ${eta.toFixed(0)}s`);
    lastLog = now;
  }
}

const wall = (Date.now() - embedT0) / 1000;
console.log(`[F13] embed wall: ${wall.toFixed(1)}s for ${turns.length} turns (${(turns.length / wall).toFixed(2)}/s)`);

writeFileSync(OUT, JSON.stringify({
  model: MODEL,
  dim: out[0].vec.length,
  count: out.length,
  turns: out,
}));
console.log(`[F13] wrote ${OUT}`);
