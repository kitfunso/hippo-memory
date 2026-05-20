#!/usr/bin/env node
/**
 * F9 Task 1 — BM25 corpus builder for the LongMemEval hybrid track.
 *
 * Builds two BM25 corpora over a LongMemEval source dataset:
 *   - Turn-level: one doc per unique (session_id, turn_idx), mirrors the
 *     chunked-turn dense index from F13/F14.
 *   - Session-level: one doc per unique session_id (turns joined by \n).
 *
 * Reuses `buildCorpus` + `tokenize` from src/search.ts via the built
 * dist/. Run `npm run build` first if dist is stale.
 *
 * Usage:
 *   node benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs <input.json> <out-prefix>
 *
 * Example (oracle):
 *   npm run build
 *   node benchmarks/longmemeval/chunk_per_turn_bm25_index.mjs \
 *     data/longmemeval_oracle.json \
 *     benchmarks/longmemeval/data/bm25_corpus_oracle
 *
 * Produces:
 *   benchmarks/longmemeval/data/bm25_corpus_oracle_turns.json
 *   benchmarks/longmemeval/data/bm25_corpus_oracle_sessions.json
 *
 * Each file contains:
 *   {
 *     "_meta": { "source": "<path>", "level": "turn"|"session", "N": ..., "avgLen": ..., "vocab": ... },
 *     "df": { "<term>": <int>, ... },
 *     "docs": [["tok", "tok", ...], ...],
 *     "ids": [{ "session_id": "...", "turn_idx": 0 }, ...]  // turns OR
 *     "ids": [{ "session_id": "..." }, ...]                  // sessions
 *   }
 *
 * Plan + prereg: docs/plans/2026-05-20-f9-hybrid-retrieval-parity.md
 *                docs/evals/2026-05-20-f9-hybrid-rrf-prereg.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildCorpus } from '../../dist/src/search.js';

const INPUT = process.argv[2];
const OUT_PREFIX = process.argv[3];

if (!INPUT || !OUT_PREFIX) {
  console.error('Usage: chunk_per_turn_bm25_index.mjs <input.json> <out-prefix>');
  console.error(
    'Example: chunk_per_turn_bm25_index.mjs data/longmemeval_oracle.json benchmarks/longmemeval/data/bm25_corpus_oracle',
  );
  process.exit(2);
}

console.log(`[f9-bm25] reading ${INPUT}...`);
const data = JSON.parse(readFileSync(INPUT, 'utf8'));
console.log(`[f9-bm25] questions: ${data.length}`);

// Unique-turn extraction mirrors chunk_per_turn_embed.mjs lines 59-72:
// dedupe by (session_id, turn_idx) across all haystacks.
const turnMap = new Map(); // "sid|tidx" -> { session_id, turn_idx, content }
for (const q of data) {
  for (let si = 0; si < q.haystack_session_ids.length; si++) {
    const sid = q.haystack_session_ids[si];
    const sess = q.haystack_sessions[si];
    for (let ti = 0; ti < sess.length; ti++) {
      const key = `${sid}|${ti}`;
      if (!turnMap.has(key)) {
        turnMap.set(key, {
          session_id: sid,
          turn_idx: ti,
          content: sess[ti].content,
        });
      }
    }
  }
}

const turns = [...turnMap.values()];
console.log(`[f9-bm25] unique turns:    ${turns.length}`);

// Group turns by session to form the session-level docs.
const sessionMap = new Map(); // session_id -> [content per turn_idx]
for (const t of turns) {
  if (!sessionMap.has(t.session_id)) sessionMap.set(t.session_id, []);
  sessionMap.get(t.session_id).push(t);
}
// Sort each session's turns by turn_idx so the concatenation order is stable.
const sessions = [...sessionMap.entries()].map(([sid, ts]) => {
  ts.sort((a, b) => a.turn_idx - b.turn_idx);
  return { session_id: sid, content: ts.map((t) => t.content).join('\n') };
});
console.log(`[f9-bm25] unique sessions: ${sessions.length}`);

// ---------------------------------------------------------------------------
// Build turn-level corpus
// ---------------------------------------------------------------------------

console.log(`[f9-bm25] building turn-level corpus (N=${turns.length})...`);
const t0Turns = Date.now();
const turnCorpus = buildCorpus(turns.map((t) => t.content));
console.log(`[f9-bm25]   build wall: ${((Date.now() - t0Turns) / 1000).toFixed(2)}s`);
console.log(`[f9-bm25]   avgLen: ${turnCorpus.avgLen.toFixed(2)}, vocab: ${turnCorpus.df.size}`);

// ---------------------------------------------------------------------------
// Build session-level corpus
// ---------------------------------------------------------------------------

console.log(`[f9-bm25] building session-level corpus (N=${sessions.length})...`);
const t0Sessions = Date.now();
const sessionCorpus = buildCorpus(sessions.map((s) => s.content));
console.log(`[f9-bm25]   build wall: ${((Date.now() - t0Sessions) / 1000).toFixed(2)}s`);
console.log(`[f9-bm25]   avgLen: ${sessionCorpus.avgLen.toFixed(2)}, vocab: ${sessionCorpus.df.size}`);

// ---------------------------------------------------------------------------
// Serialise. Map → plain object for JSON compatibility.
// ---------------------------------------------------------------------------

function serialise(corpus, level, source, ids) {
  const df = Object.fromEntries(corpus.df.entries());
  return {
    _meta: {
      source,
      level,
      N: corpus.N,
      avgLen: corpus.avgLen,
      vocab: corpus.df.size,
      builtAt: new Date().toISOString(),
    },
    df,
    docs: corpus.docs,
    ids,
  };
}

mkdirSync(dirname(OUT_PREFIX), { recursive: true });

const turnsOut = `${OUT_PREFIX}_turns.json`;
const sessionsOut = `${OUT_PREFIX}_sessions.json`;

writeFileSync(
  turnsOut,
  JSON.stringify(
    serialise(
      turnCorpus,
      'turn',
      INPUT,
      turns.map((t) => ({ session_id: t.session_id, turn_idx: t.turn_idx })),
    ),
    null,
    0,
  ),
);
console.log(`[f9-bm25] wrote ${turnsOut}`);

writeFileSync(
  sessionsOut,
  JSON.stringify(
    serialise(
      sessionCorpus,
      'session',
      INPUT,
      sessions.map((s) => ({ session_id: s.session_id })),
    ),
    null,
    0,
  ),
);
console.log(`[f9-bm25] wrote ${sessionsOut}`);

// Gate-A items 1 + 2 sanity checks ----------------------------------------
const issues = [];
if (turnCorpus.N < 1) issues.push(`turn corpus N=${turnCorpus.N} < 1`);
if (turnCorpus.avgLen <= 0) issues.push(`turn corpus avgLen=${turnCorpus.avgLen} <= 0`);
if (turnCorpus.df.size <= 0) issues.push(`turn corpus df.size=${turnCorpus.df.size} <= 0`);
if (sessionCorpus.N < 1) issues.push(`session corpus N=${sessionCorpus.N} < 1`);
if (sessionCorpus.avgLen <= turnCorpus.avgLen) {
  issues.push(
    `session avgLen (${sessionCorpus.avgLen.toFixed(2)}) must be > turn avgLen (${turnCorpus.avgLen.toFixed(2)})`,
  );
}
if (issues.length) {
  console.error(`[f9-bm25] GATE-A FAIL: ${issues.join('; ')}`);
  process.exit(1);
}
console.log(`[f9-bm25] GATE-A PASS (items 1-2)`);
