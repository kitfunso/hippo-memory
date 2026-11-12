#!/usr/bin/env node
/**
 * Hippo behind the three HTTP calls Mem0's benchmark runner makes
 * (github.com/mem0ai/memory-benchmarks, `--backend oss`), so that runner can
 * score hippo unchanged: same datasets, prompts, answering and judging models.
 * Pre-registration: docs/evals/2026-09-24-public-benchmarks-prereg.md.
 *
 *   POST   /memories  {messages, user_id, timestamp}   store one chunk
 *   POST   /search    {query, user_id, limit}          ranked memories
 *   DELETE /memories?user_id=...                       drop a user's store
 *
 * Each chunk the runner sends is stored verbatim as one memory ("role:
 * content" lines), dated with the session timestamp the runner sends. Each
 * user gets its own store under --data-dir. Search ranks with hippo's
 * hybridSearch ("hippo" arm) or by the BM25 component alone ("bm25" arm),
 * with "now" one day after the user's latest memory.
 *
 * Usage:
 *   npm run build
 *   node benchmarks/public/hippo-mem0-server.mjs --arm hippo --port 8888 --data-dir /tmp/hippo-bench
 *   # then, in memory-benchmarks: MEM0_HOST=http://localhost:8888 python -m benchmarks.locomo.run --backend oss ...
 *
 * Optional: --dist DIR serves another hippo build (default: this checkout's dist),
 * --host ADDR binds one address (default: all), --read-only answers only
 * POST /search and GET /health and refuses every other route with 403.
 * --reranker-top-k N re-orders the top N with hippo's local cross-encoder (`hippo recall
 * --reranker cross-encoder`); --rank-score returns 1 - rank/limit as the score, so a client
 * that sorts by score keeps hippo's final order (dated notes 9).
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DIST = path.resolve(arg('dist', path.join(REPO, 'dist')));
// pathToFileURL: Windows' ESM loader rejects a bare "C:/..." specifier.
const distImport = (name) => import(pathToFileURL(path.join(DIST, name)).href);
const { createMemoryWire: createMemory } = await distImport('entry/testing.js');
const { initStore, loadAllEntriesWire: loadAllEntries } = await distImport('entry/testing.js');
const { batchWriteAndDeleteWire: batchWriteAndDelete } = await distImport('entry/testing.js');
const { hybridSearchWire: hybridSearch } = await distImport('entry/testing.js');
const { embedMemoryWire: embedMemory } = await distImport('entry/testing.js');
const { isEmbeddingAvailable } = await distImport('base/embeddings/local.js');
const { getEmbedding } = await distImport('infra/local-embedder.js');
const { createCrossEncoderReranker } = await distImport('domain/rerankers/cross-encoder.js');
const { transformersCrossEncoder } = await distImport('infra/cross-encoder.js');

const ARM = arg('arm', 'hippo');
const PORT = Number(arg('port', '8888'));
const HOST = arg('host', undefined);
const READ_ONLY = args.includes('--read-only');
const DATA_DIR = path.resolve(arg('data-dir', path.join(REPO, 'benchmarks', 'public', 'stores')));
// eval-only: overrides the shipped half-life default for sensitivity checks (Amendment 2).
const HALF_LIFE_DAYS = arg('half-life-days', undefined);
const DAY_MS = 86_400_000;
if (!['hippo', 'bm25'].includes(ARM)) throw new Error(`--arm must be hippo or bm25, got ${ARM}`);
// Amendment 2 fixes "no embeddings on any arm" regardless of what's installed locally.
const EMBED = ARM === 'hippo' && isEmbeddingAvailable() && arg('embeddings', '0') === '1';
const RERANK_K = Number(arg('reranker-top-k', '0'));
const RANK_SCORE = args.includes('--rank-score');
if (!Number.isInteger(RERANK_K) || RERANK_K < 0) throw new Error(`--reranker-top-k must be a whole number, got ${RERANK_K}`);
if (RERANK_K > 0 && ARM !== 'hippo') throw new Error('--reranker-top-k needs --arm hippo');
// A cold model can outlast the 5 s query-embedding deadline, and that search then runs on BM25 alone.
if (EMBED && (await getEmbedding('probe')).length === 0) throw new Error('the local embedder returned no vector');
// hippo keeps the base score for a candidate the cross-encoder fails on; the bench counts those and fails the search.
let crossEncoderFailures = 0;
const crossEncoder = transformersCrossEncoder();
async function countedCrossEncoder() {
  const pipe = await crossEncoder().catch((err) => { crossEncoderFailures++; throw err; });
  return async (query, text) => pipe(query, text).catch((err) => { crossEncoderFailures++; throw err; });
}
const RERANKER = RERANK_K > 0 ? createCrossEncoderReranker(countedCrossEncoder) : undefined;
if (RERANKER) {
  const score = await (await countedCrossEncoder())('probe', 'probe text');
  if (!Number.isFinite(score)) throw new Error('cross-encoder self-check returned a non-finite score');
}

/** Per-user store root. The user id is hashed so any string is a safe path. */
function rootFor(userId) {
  const slug = String(userId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const hash = createHash('sha256').update(String(userId)).digest('hex').slice(0, 10);
  return path.join(DATA_DIR, `${slug}-${hash}`, '.hippo');
}

/** Entries per user, dropped whenever that user's store changes. */
const cache = new Map();
function entriesFor(userId) {
  const root = rootFor(userId);
  if (!cache.has(root)) cache.set(root, fs.existsSync(root) ? loadAllEntries(root) : []);
  return cache.get(root);
}

/** Store one chunk of messages as one memory dated at the session time. */
async function addChunk(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const text = messages
    .filter((m) => m && String(m.content ?? '').trim())
    .map((m) => `${m.role ?? 'user'}: ${String(m.content).trim()}`)
    .join('\n');
  if (text.trim().length < 3) return { results: [] };
  const root = rootFor(body.user_id);
  initStore(root);
  const opts = { tags: ['benchmark'], source: 'benchmark' };
  if (HALF_LIFE_DAYS !== undefined) opts.baseHalfLifeDays = Number(HALF_LIFE_DAYS);
  const entry = createMemory(text, opts);
  if (Number.isFinite(body.timestamp)) {
    const iso = new Date(Number(body.timestamp) * 1000).toISOString();
    entry.created = iso;
    entry.last_retrieved = iso;
  }
  batchWriteAndDelete(root, [entry], []);
  if (EMBED) await embedMemory(root, entry);
  cache.delete(root);
  return { results: [{ id: entry.id, memory: text, event: 'ADD' }] };
}

/** Rank the user's memories for a query and return Mem0's result shape. */
async function search(body) {
  const entries = entriesFor(body.user_id);
  if (entries.length === 0) return { results: [] };
  const limit = Math.max(1, Math.min(Number(body.limit) || 200, 1000));
  const latest = Math.max(...entries.map((e) => Date.parse(e.created)));
  const now = new Date(latest + DAY_MS);
  const failuresBefore = crossEncoderFailures;
  const results = await hybridSearch(String(body.query ?? ''), entries, {
    budget: 100_000_000,
    minResults: limit,
    now,
    hippoRoot: rootFor(body.user_id),
    ...(RERANKER && { reranker: RERANKER, rerankerOptions: { topK: RERANK_K } }),
  });
  if (crossEncoderFailures !== failuresBefore) {
    throw new Error(`the cross-encoder failed on ${crossEncoderFailures - failuresBefore} candidates`);
  }
  const ranked = ARM === 'bm25'
    ? results.slice().sort((a, b) => (b.bm25 - a.bm25) || a.entry.id.localeCompare(b.entry.id))
    : results;
  return {
    results: ranked.slice(0, limit).map((r, i) => ({
      id: r.entry.id,
      memory: r.entry.content,
      score: ARM === 'bm25' ? r.bm25 : RANK_SCORE ? 1 - i / limit : r.score,
      created_at: r.entry.created,
    })),
  };
}

function deleteUser(userId) {
  const root = rootFor(userId);
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  cache.delete(root);
  return { message: 'deleted' };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// One request at a time: each user's store is a single SQLite file, and the
// runner's parallel adds must land in order.
let queue = Promise.resolve();
const server = http.createServer((req, res) => {
  queue = queue.then(async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    try {
      let out;
      // Search is a POST but reads only, so read-only mode allows it and GET alone.
      if (READ_ONLY && req.method !== 'GET' && !(req.method === 'POST' && url.pathname === '/search')) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'read-only server: only POST /search and GET /health are served' }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/memories') out = await addChunk(await readBody(req));
      else if (req.method === 'POST' && url.pathname === '/search') out = await search(await readBody(req));
      else if (req.method === 'DELETE' && url.pathname === '/memories') out = deleteUser(url.searchParams.get('user_id') ?? '');
      else if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) out = { status: 'ok', arm: ARM, embeddings: EMBED, halfLifeDays: HALF_LIFE_DAYS ?? null, readOnly: READ_ONLY, rerankerTopK: RERANK_K, rankScore: RANK_SCORE };
      else { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
});
// Idle connections outlive aiohttp's 15 s pool: Node's 5 s default closed them as the runner reused them (notes 7).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
if (!READ_ONLY) fs.mkdirSync(DATA_DIR, { recursive: true });
server.listen({ port: PORT, host: HOST }, () => console.error(`hippo-mem0-server arm=${ARM} embeddings=${EMBED} halfLifeDays=${HALF_LIFE_DAYS ?? 'default'} rerankerTopK=${RERANK_K} rankScore=${RANK_SCORE} readOnly=${READ_ONLY} host=${HOST ?? 'all'} port=${PORT} data=${DATA_DIR} dist=${DIST}`));
