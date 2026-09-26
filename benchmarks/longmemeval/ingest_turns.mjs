#!/usr/bin/env node
// Round-2 lane #5 (docs/evals/2026-09-23-mechanism-audit-round2-prereg.md): one memory per turn, not per session.
// Usage: node ingest_turns.mjs --data <longmemeval.json> --store-dir <dir>  (run `hippo init` in <dir> first)
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemory } from '../../dist/memory.js';
import { initStore, writeEntryDbOnly, writeIndexMirror, buildIndexFromDb } from '../../dist/store.js';
import { openHippoDb, closeHippoDb } from '../../dist/db.js';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const data = getArg('data'), storeDir = getArg('store-dir');
if (!data || !storeDir) throw new Error('usage: ingest_turns.mjs --data <json> --store-dir <dir>');

const raw = JSON.parse(readFileSync(data, 'utf8'));
const questions = Array.isArray(raw) ? raw : (raw.data ?? raw.questions ?? raw.entries);
// First occurrence of each session wins, as in ingest.py collect_sessions.
const sessions = new Map();
for (const q of questions) {
  (q.haystack_sessions ?? []).forEach((turns, i) => {
    const sid = q.haystack_session_ids?.[i] ?? `session_${i}`;
    if (!sessions.has(sid)) sessions.set(sid, { date: q.haystack_dates?.[i] ?? '', turns });
  });
}

// Python str.capitalize(): first letter upper, the rest lower.
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const hippoRoot = resolve(storeDir, '.hippo');
initStore(hippoRoot);
const db = openHippoDb(hippoRoot);
let written = 0, long = 0;
try {
  // writeEntryDbOnly skips mirrors entirely; index.json is written once below, after the batch commits.
  db.exec('BEGIN');
  for (const [sid, { date, turns }] of sessions) {
    turns.forEach((turn, t) => {
      const text = String(turn.content ?? '');
      const head = (date ? `[Date: ${date}]\n` : '') + `[Session: ${sid}]\n\n`;
      const entry = createMemory(`${head}${capitalize(turn.role ?? 'unknown')}: ${text}`, {
        tags: date ? [sid, `date:${date}`] : [sid], confidence: 'verified', source: 'cli',
      });
      entry.id = 'mem_' + createHash('sha256').update(`${sid}:${t}`).digest('hex').slice(0, 12);
      writeEntryDbOnly(db, entry);
      written++;
      if (text.split(/\s+/).filter(Boolean).length > 180) long++;
    });
  }
  db.exec('COMMIT');
  writeIndexMirror(hippoRoot, buildIndexFromDb(db));
} finally {
  closeHippoDb(db);
}
console.log(`sessions=${sessions.size} turns=${written} turns_over_180_words=${long}`);
