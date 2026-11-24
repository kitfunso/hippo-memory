#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemory } from '../../dist/entry/memory.js';
import { writeIndexMirror, buildIndexFromDb } from '../../dist/entry/testing.js';
import { initStore } from '../../dist/entry/testing.js';
import { writeEntryDbOnly } from '../../dist/entry/testing.js';
import { openHippoDb, closeHippoDb } from '../../dist/db/index.js';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const data = getArg('data'), storeDir = getArg('store-dir');
if (!data || !storeDir) throw new Error('usage: ingest_turns.mjs --data <json> --store-dir <dir>');

const raw = JSON.parse(readFileSync(data, 'utf8'));
const questions = Array.isArray(raw) ? raw : (raw.data ?? raw.questions ?? raw.entries);
const sessions = new Map();
for (const q of questions) {
  (q.haystack_sessions ?? []).forEach((turns, i) => {
    const sid = q.haystack_session_ids?.[i] ?? `session_${i}`;
    if (!sessions.has(sid)) sessions.set(sid, { date: q.haystack_dates?.[i] ?? '', turns });
  });
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
const hippoRoot = resolve(storeDir, '.hippo');
initStore(hippoRoot);
const db = openHippoDb(hippoRoot);
let written = 0, long = 0;
try {
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
