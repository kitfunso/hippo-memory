#!/usr/bin/env node
import { readFileSync, renameSync, mkdirSync, existsSync, openSync, writeSync, closeSync, createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const MODEL = process.argv[2] || 'Xenova/multilingual-e5-large';
const OUT = process.argv[3] || (
  MODEL.includes('bge') ? 'benchmarks/longmemeval/data/turn_index_bge.json' :
  'benchmarks/longmemeval/data/turn_index_e5.json'
);
const DATA = process.argv[4] || 'data/longmemeval_oracle.json';
const IS_E5 = /\be5\b/i.test(MODEL);
const IS_BGE = /\bbge\b/i.test(MODEL);
const POOLING = IS_BGE ? 'cls' : 'mean';

if (!process.env.HIPPO_MODEL_CACHE) {
  process.env.HIPPO_MODEL_CACHE = resolve('benchmarks/longmemeval/data/model-cache');
}

const { pipeline, env } = await import(process.env.LME_TRANSFORMERS || '@huggingface/transformers');
env.cacheDir = process.env.HIPPO_MODEL_CACHE;
env.localModelPath = process.env.HIPPO_MODEL_CACHE;
env.allowRemoteModels = false;

console.log(`[F13] loading ${MODEL}...`);
const t0 = Date.now();
const pipe = await pipeline('feature-extraction', MODEL);
console.log(`[F13] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const data = JSON.parse(readFileSync(DATA, 'utf8'));

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

const allTurns = [...uniq.values()];
console.log(`[F13] unique turns total: ${allTurns.length}`);
console.log(`[F13] unique sessions:    ${new Set(allTurns.map(t => t.session_id)).size}`);

mkdirSync(dirname(OUT), { recursive: true });

// Output format: JSONL (one turn per line, no trailing array wrap).
// First line is metadata { "_meta": { model, dim, count } }; subsequent
// lines are turn objects. JSONL avoids Node's ~512 MB string-length cap on
// JSON.stringify, which crashes any large embed (~50k turns at 768-dim FP32
// ≈ 600 MB encoded). Each turn is appended atomically, so the file is
// always parseable line-by-line up to the last fully-written line.
// Read side: streams line-by-line; never materialises the whole file as a
// single string. See chunk_per_turn_retrieve.mjs for the matching loader.
const PARTIAL = OUT + '.partial.jsonl';
const FINAL_JSONL = OUT + '.jsonl';
const done = new Set();
let resumedCount = 0;
let resumedDim = 0;

async function loadJsonlIntoDone(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    if (t && t._meta) continue;
    if (t && t.session_id != null && t.turn_idx != null && Array.isArray(t.vec)) {
      const key = `${t.session_id}|${t.turn_idx}`;
      if (!done.has(key)) {
        done.add(key);
        if (!resumedDim) resumedDim = t.vec.length;
        resumedCount++;
      }
    }
  }
}

function loadLegacyJsonIntoDone(path) {
  const prev = JSON.parse(readFileSync(path, 'utf8'));
  if (prev && Array.isArray(prev.turns)) {
    for (const t of prev.turns) {
      const key = `${t.session_id}|${t.turn_idx}`;
      if (!done.has(key)) {
        done.add(key);
        if (!resumedDim) resumedDim = t.vec?.length || 0;
        resumedCount++;
      }
    }
  }
  return prev?.turns ?? [];
}

const LEGACY_PARTIAL = OUT + '.partial';
const LEGACY_FINAL = OUT;

let appendFd = null;
function openAppend(path) {
  return openSync(path, 'a');
}

if (existsSync(FINAL_JSONL)) {
  await loadJsonlIntoDone(FINAL_JSONL);
  console.log(`[F13] found existing JSONL: ${FINAL_JSONL} (${resumedCount} turns)`);
} else if (existsSync(PARTIAL)) {
  await loadJsonlIntoDone(PARTIAL);
  console.log(`[F13] resuming from JSONL partial: ${PARTIAL} (${resumedCount} turns)`);
} else if (existsSync(LEGACY_PARTIAL)) {
  console.log(`[F13] migrating legacy partial ${LEGACY_PARTIAL} -> ${PARTIAL}`);
  const legacyTurns = loadLegacyJsonIntoDone(LEGACY_PARTIAL);
  const tmp = PARTIAL + '.tmp';
  const fd = openSync(tmp, 'w');
  writeSync(fd, JSON.stringify({ _meta: { model: MODEL, dim: resumedDim, count: legacyTurns.length } }) + '\n');
  for (const t of legacyTurns) writeSync(fd, JSON.stringify(t) + '\n');
  closeSync(fd);
  renameSync(tmp, PARTIAL);
  console.log(`[F13] migrated ${legacyTurns.length} turns to JSONL`);
} else if (existsSync(LEGACY_FINAL)) {
  console.log(`[F13] migrating legacy final ${LEGACY_FINAL} -> ${FINAL_JSONL}`);
  const legacyTurns = loadLegacyJsonIntoDone(LEGACY_FINAL);
  const tmp = PARTIAL + '.tmp';
  const fd = openSync(tmp, 'w');
  writeSync(fd, JSON.stringify({ _meta: { model: MODEL, dim: resumedDim, count: legacyTurns.length } }) + '\n');
  for (const t of legacyTurns) writeSync(fd, JSON.stringify(t) + '\n');
  closeSync(fd);
  renameSync(tmp, PARTIAL);
}

const remaining = allTurns.filter(t => !done.has(`${t.session_id}|${t.turn_idx}`));
console.log(`[F13] turns remaining to embed: ${remaining.length}`);

appendFd = openAppend(PARTIAL);
if (resumedCount === 0) {
  writeSync(appendFd, JSON.stringify({ _meta: { model: MODEL, dim: 0, count: 0, note: 'dim filled in by retrieve loader if 0' } }) + '\n');
}

const embedT0 = Date.now();
let lastLog = embedT0;
let dimObserved = resumedDim || 0;
for (let i = 0; i < remaining.length; i++) {
  const t = remaining[i];
  const input = IS_E5 ? `passage: ${t.content}` : t.content;
  const res = await pipe(input, { pooling: POOLING, normalize: true });
  const vec = Array.from(res.data);
  if (!dimObserved) dimObserved = vec.length;
  const rec = {
    session_id: t.session_id,
    turn_idx: t.turn_idx,
    role: t.role,
    content: t.content,
    vec,
  };
  writeSync(appendFd, JSON.stringify(rec) + '\n');
  const now = Date.now();
  if (now - lastLog > 30_000 || i === remaining.length - 1) {
    const rate = (i + 1) / ((now - embedT0) / 1000);
    const eta = (remaining.length - i - 1) / rate;
    const total = resumedCount + i + 1;
    console.log(`[F13] ${i + 1}/${remaining.length}  ${rate.toFixed(2)}/s  ETA ${eta.toFixed(0)}s  (total ${total}/${allTurns.length})`);
    lastLog = now;
  }
}

closeSync(appendFd);
const wall = (Date.now() - embedT0) / 1000;
console.log(`[F13] embed wall: ${wall.toFixed(1)}s for ${remaining.length} new turns (${(remaining.length / wall || 0).toFixed(2)}/s)`);

renameSync(PARTIAL, FINAL_JSONL);
console.log(`[F13] wrote ${FINAL_JSONL}`);
