#!/usr/bin/env node
// Paired per-question comparison of two retrieve_inprocess.mjs outputs (docs/evals/2026-09-23-mechanism-audit-prereg.md).
// Usage: node benchmarks/longmemeval/paired_hits.mjs --data <json> --a <jsonl> --b <jsonl> [--fire-only]
// --fire-only prints only how many top-5 lists differ, so a dry run proves the switch fires without a peek at hit rates.
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const B = 10000;

const raw = JSON.parse(fs.readFileSync(getArg('data'), 'utf8'));
const questions = Array.isArray(raw) ? raw : (raw.data ?? raw.questions ?? raw.entries);
const answers = new Map(questions.map((q) => [q.question_id, q.answer_session_ids ?? []]));

function load(file) {
  const rows = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    rows.set(r.question_id, r.retrieved_memories ?? []);
  }
  return rows;
}

// Same rule as evaluate_retrieval.py check_session_hit; a question with no answer sessions is a miss there too.
function hit(memories, sids, k) {
  return memories.slice(0, k).some((m) => sids.some((sid) =>
    (m.tags ?? []).some((t) => t.includes(sid)) || (m.content ?? '').includes(`[Session: ${sid}]`)));
}

const A = load(getArg('a')), Bm = load(getArg('b'));
const qids = [...A.keys()].filter((q) => Bm.has(q) && answers.has(q));
const top5 = (rows, q) => rows.get(q).slice(0, 5).map((m) => m.id).join();
const differ = qids.filter((q) => top5(A, q) !== top5(Bm, q)).length;
console.log(`n=${qids.length} questions; top-5 lists differ on ${differ} (${(100 * differ / qids.length).toFixed(1)}%)`);
if (args.includes('--fire-only')) process.exit(0);

let s = 1;
const rng = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const pp = (x) => (x * 100).toFixed(1);

for (const k of [1, 5, 10]) {
  const ha = qids.map((q) => Number(hit(A.get(q), answers.get(q), k)));
  const hb = qids.map((q) => Number(hit(Bm.get(q), answers.get(q), k)));
  const d = ha.map((x, i) => x - hb[i]);
  const draws = [];
  for (let i = 0; i < B; i++) {
    let sum = 0;
    for (let j = 0; j < d.length; j++) sum += d[Math.floor(rng() * d.length)];
    draws.push(sum / d.length);
  }
  draws.sort((x, y) => x - y);
  const n = qids.length, sa = ha.reduce((x, y) => x + y, 0), sb = hb.reduce((x, y) => x + y, 0);
  console.log(`hit@${k}: A ${pp(sa / n)} B ${pp(sb / n)} | A-B ${pp((sa - sb) / n)}pp ` +
    `95% [${pp(pct(draws, 0.025))}, ${pp(pct(draws, 0.975))}] 99% [${pp(pct(draws, 0.005))}, ${pp(pct(draws, 0.995))}] | ` +
    `A-only ${d.filter((x) => x === 1).length}, B-only ${d.filter((x) => x === -1).length}`);
}
