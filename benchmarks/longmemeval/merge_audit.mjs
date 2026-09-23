#!/usr/bin/env node
// Mechanism-audit diagnostic (undeclared): how sleep's merged memories meet the session-hit rule.
// Prints store facts, then writes header-only and text-credit copies of the four retrieval files for
// paired_hits.mjs to score unchanged. Usage: merge_audit.mjs --data <oracle.json> --run <dir> --out <dir>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const [data, run, out] = ['data', 'run', 'out'].map(getArg);
if (!data || !run || !out) throw new Error('usage: merge_audit.mjs --data <oracle.json> --run <dir> --out <dir>');

const questions = JSON.parse(readFileSync(data, 'utf8'));
const answers = new Map(questions.map((q) => [q.question_id, q.answer_session_ids ?? []]));
const owners = new Map();
for (const q of questions) for (const s of q.answer_session_ids ?? []) owners.set(s, [...(owners.get(s) ?? []), q.question_id]);

const open = (store) => new DatabaseSync(join(run, store, '.hippo', 'hippo.db'), { readOnly: true });
const rows = (store) => open(store).prepare('SELECT id, layer, tags_json, content FROM memories').all();
const bareIds = (store) => new Set(open(store)
  .prepare('SELECT id FROM memories WHERE id NOT IN (SELECT memory_id FROM memory_physics)').all().map((r) => r.id));
const sessionTags = (r) => JSON.parse(r.tags_json || '[]').filter((t) => t.startsWith('answer_'));
const never = rows('nosleep'), slept = rows('sleep');

const snippet = new Map();
for (const r of never) {
  const sid = r.content.match(/\[Session: ([^\]]+)\]/)?.[1];
  const mid = r.content.length >> 1;
  if (sid) snippet.set(sid, r.content.slice(mid, mid + 80));
}
const holds = (text, sid, withSnippet) =>
  text.includes(`[Session: ${sid}]`) || (withSnippet && snippet.has(sid) && text.includes(snippet.get(sid)));

const merged = slept.filter((r) => r.layer === 'semantic');
const multiQuestion = merged.filter((r) => new Set(sessionTags(r).flatMap((s) => owners.get(s) ?? [])).size > 1);
let inRow = 0, elsewhere = 0, missing = 0;
for (const r of merged) for (const s of sessionTags(r)) {
  if (r.content.includes(`[Session: ${s}]`)) continue;
  if (holds(r.content, s, true)) inRow++;
  else if (slept.some((x) => holds(x.content, s, true))) elsewhere++;
  else missing++;
}
console.log(`rows: never-slept ${never.length}, slept ${slept.length} (${merged.length} merged by sleep, ` +
  `${merged.filter((r) => sessionTags(r).length > 1).length} tagged with more than one session, ${multiQuestion.length} with sessions of more than one question)`);
console.log(`session tags on a merged row without that session's header: ${inRow + elsewhere + missing}; ` +
  `its text is in the row ${inRow}, elsewhere in the slept store ${elsewhere}, not found ${missing}`);
const bareSlept = bareIds('sleep');
console.log(`memories without a physics particle: never-slept ${bareIds('nosleep').size}, ` +
  `slept ${bareSlept.size} (${merged.filter((r) => bareSlept.has(r.id)).length} of them merged by sleep)`);

const load = (f) => new Map(readFileSync(join(run, `ret-${f}.jsonl`), 'utf8').trim().split('\n')
  .map((l) => JSON.parse(l)).map((r) => [r.question_id, r.retrieved_memories ?? []]));
// Same rule as paired_hits.mjs, on a top five that is already cut.
const hit = (top, sids) => top.some((m) => sids.some((sid) =>
  (m.tags ?? []).some((t) => t.includes(sid)) || (m.content ?? '').includes(`[Session: ${sid}]`)));
const mergedIds = new Set(merged.map((r) => r.id));
const sleepHybrid = load('sleep-hybrid'), nosleepHybrid = load('nosleep-hybrid');
let aOnly = 0, viaMerged = 0;
for (const [q, sids] of answers) {
  const top = sleepHybrid.get(q).slice(0, 5);
  if (!hit(top, sids) || hit(nosleepHybrid.get(q).slice(0, 5), sids)) continue;
  aOnly++;
  if (!hit(top.filter((m) => !mergedIds.has(m.id)), sids)) viaMerged++;
}
console.log(`L4 hit@5 A-only questions ${aOnly}, of which a merged row is the only hit in ${viaMerged}`);
for (const f of ['sleep-hybrid', 'sleep-physics', 'nosleep-hybrid', 'nosleep-physics']) {
  const ids = new Set((f.startsWith('sleep') ? slept : never).map((r) => r.id));
  const all = [...load(f).values()].flat();
  console.log(`ret-${f}: ${all.length} retrieved, ${all.filter((m) => !ids.has(m.id)).length} missing from its store, ` +
    `${all.filter((m) => mergedIds.has(m.id)).length} are memories sleep merged`);
}

for (const [mode, withSnippet] of [['header', false], ['text', true]]) {
  mkdirSync(join(out, mode), { recursive: true });
  for (const f of ['sleep-hybrid', 'sleep-physics', 'nosleep-hybrid', 'nosleep-physics']) {
    const lines = readFileSync(join(run, `ret-${f}.jsonl`), 'utf8').trim().split('\n').map((line) => {
      const r = JSON.parse(line);
      const sids = answers.get(r.question_id) ?? [];
      r.retrieved_memories = (r.retrieved_memories ?? []).map((m) =>
        ({ id: m.id, tags: sids.filter((s) => holds(String(m.content ?? ''), s, withSnippet)), content: '' }));
      return JSON.stringify(r);
    });
    writeFileSync(join(out, mode, `ret-${f}.jsonl`), lines.join('\n') + '\n');
  }
}
