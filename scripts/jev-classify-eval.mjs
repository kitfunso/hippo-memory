#!/usr/bin/env node
/** Lane 3 of docs/EXPERIMENT-PROTOCOL.md: can Jev recover hippo's `error` tag
 *  from content alone, beating the content-only baselines that already fail?
 *  Usage: node scripts/jev-classify-eval.mjs [--limit N] [--seed N] */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const COST_PER_CALL_USD = 0.0004;
const NOISE_FLOOR_AUC = 0.075;
const BOOTSTRAP_DRAWS = 2000;
const CONCURRENCY = 8;

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
if (!apiKey) { console.error('TYPESAFE_API_KEY is not set.'); process.exit(1); }

const limit = Number(arg('limit', '400'));
const seed = Number(arg('seed', '20260918'));
const dbPath = join(homedir(), '.hippo', 'hippo.db');

let rngState = seed;
function rng() {
  rngState = (rngState * 1664525 + 1013904223) % 4294967296;
  return rngState / 4294967296;
}

const QUESTIONS = {
  isError: {
    type: 'noul',
    instructions:
      'This is a note an AI coding agent stored about a software project. Answer the probability that a careful engineer would file it under "things that went wrong and why": a failure, a bug, a crash, a gotcha, a mistake that was made, or a warning about a trap to avoid in future. Notes that only state how something works, a preference, a plan, or a neutral fact are not in that category.',
  },
  kind: {
    type: 'choice',
    instructions: 'Classify what kind of knowledge this note carries.',
    criteria: {
      error: 'A failure, gotcha, mistake, or warning about a trap, and why it happened.',
      decision: 'A choice that was made, ideally with its reason.',
      convention: 'A rule, standard, or way this project does things.',
      preference: 'A stated preference of the user or team.',
      trivia: 'None of the above; incidental detail with no reuse value.',
    },
  },
};

async function ask(content) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ state: content, model: 'jev-latest', questions: QUESTIONS }),
      });
      if (res.status === 429 || res.status === 529) { await new Promise((r) => setTimeout(r, 800)); continue; }
      if (!res.ok) return null;
      const d = await res.json();
      const p = d.answers?.isError?.noul;
      const kind = d.answers?.kind?.choice;
      if (!Number.isFinite(p) || p < 0 || p > 1 || !kind) return null;
      return { p, kind, kindConfidence: d.answers?.kind?.confidence ?? 0 };
    } catch { return null; }
  }
  return null;
}

const db = new DatabaseSync(dbPath);
const all = db.prepare(`
  SELECT id, content, source, tags_json FROM memories
  WHERE kind != 'archived' AND length(content) > 20
`).all();

const isErr = (r) => { try { return JSON.parse(r.tags_json).includes('error'); } catch { return false; } };
const coarse = (s) => ((s ?? '').startsWith('shared:') ? 'shared' : (s ?? '').startsWith('claude-memory:') ? 'claude-memory' : (s || 'null'));

const family = arg('family', null);
const excludeFile = arg('exclude', null);
const spent = new Set(excludeFile
  ? JSON.parse(await import('node:fs/promises').then((m) => m.readFile(excludeFile, 'utf8'))).rows.map((x) => x.id)
  : []);
const eligible = all.filter((r) => (!family || coarse(r.source) === family) && !spent.has(r.id));
if (family || excludeFile) {
  console.log(`HOLDOUT LANE: family='${family ?? 'any'}', excluded ${spent.size} already-scored ids, ${eligible.length} untouched rows remain`);
}

const rows = eligible.map((r) => ({ r, k: rng() })).sort((a, b) => a.k - b.k).slice(0, limit).map((x) => x.r);
console.log(`Lane 3: scoring ${rows.length} of ${all.length} rows (seed ${seed}), cost $${(rows.length * COST_PER_CALL_USD).toFixed(4)}\n`);

const started = Date.now();
const out = Array.from({ length: rows.length }, () => null);
let cursor = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (cursor < rows.length) { const i = cursor++; out[i] = await ask(rows[i].content); }
}));
const elapsed = (Date.now() - started) / 1000;

const scored = rows.map((r, i) => ({ r, j: out[i] })).filter((x) => x.j);
const failed = rows.length - scored.length;
if (scored.length < 100) { console.error(`Only ${scored.length} succeeded; too thin. Aborting.`); process.exit(1); }

const sourcePrior = {};
for (const r of all) { const c = coarse(r.source); sourcePrior[c] = sourcePrior[c] || [0, 0]; sourcePrior[c][isErr(r) ? 0 : 1]++; }
const priorOf = (s) => { const v = sourcePrior[coarse(s)]; return v ? v[0] / (v[0] + v[1]) : 0.5; };

const KW = /\b(error|fail|failed|failing|wrong|broke|broken|gotcha|bug|crash|never|cannot|do not)\b/i;
const SCORERS = {
  'Jev isError': (x) => x.j.p,
  'keyword regex': (x) => (KW.test(x.r.content) ? 1 : 0),
  'content length': (x) => x.r.content.length,
  'coin flip': () => rng(),
  'source prior (LEAK)': (x) => priorOf(x.r.source),
};
const CONTENT_ONLY = ['keyword regex', 'content length', 'coin flip'];

function auc(items, score) {
  const pos = [], neg = [];
  for (const x of items) (isErr(x.r) ? pos : neg).push(score(x));
  if (!pos.length || !neg.length) return NaN;
  let w = 0;
  for (const p of pos) for (const n of neg) w += p > n ? 1 : p === n ? 0.5 : 0;
  return w / (pos.length * neg.length);
}
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : ' n/a ');

console.log('AUC vs the `error` tag   (0.500 = chance, noise floor +-0.075)\n');
const aucTable = {};
for (const [name, s] of Object.entries(SCORERS)) {
  aucTable[name] = auc(scored, s);
  console.log(`  ${name.padEnd(22)} ${fmt(aucTable[name])}${CONTENT_ONLY.includes(name) ? '' : name.startsWith('Jev') ? '' : '   <- metadata, not a fair bar'}`);
}

function mcc(pred) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const x of scored) { const e = isErr(x.r), k = pred(x); if (e && k) tp++; else if (!e && k) fp++; else if (e && !k) fn++; else tn++; }
  const d = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn));
  return { mcc: d ? (tp * tn - fp * fn) / d : 0, acc: (tp + tn) / scored.length, prec: tp / (tp + fp) || 0, rec: tp / (tp + fn) || 0, tp, fp, fn, tn };
}
const jevHard = mcc((x) => x.j.kind === 'error');
const kwHard = mcc((x) => KW.test(x.r.content));
console.log('\nHard classification vs the tag\n');
console.log(`  Jev kind=='error'      MCC ${fmt(jevHard.mcc)}  acc ${fmt(jevHard.acc)}  prec ${fmt(jevHard.prec)}  rec ${fmt(jevHard.rec)}`);
console.log(`  keyword regex          MCC ${fmt(kwHard.mcc)}  acc ${fmt(kwHard.acc)}  prec ${fmt(kwHard.prec)}  rec ${fmt(kwHard.rec)}`);

function pairedDelta(baselineName, items = scored) {
  const b = SCORERS[baselineName], j = SCORERS['Jev isError'];
  const point = auc(items, j) - auc(items, b);
  const ds = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const s = Array.from({ length: items.length }, () => items[Math.floor(rng() * items.length)]);
    const v = auc(s, j) - auc(s, b);
    if (Number.isFinite(v)) ds.push(v);
  }
  ds.sort((a, b2) => a - b2);
  return { point, lo: ds[Math.floor(ds.length * 0.025)], hi: ds[Math.floor(ds.length * 0.975)] };
}

const best = CONTENT_ONLY.reduce((a, b) => (aucTable[a] >= aucTable[b] ? a : b));
const d = pairedDelta(best);
const passAuc = d.point > NOISE_FLOOR_AUC && d.lo > 0;
const passMcc = jevHard.mcc > kwHard.mcc;
console.log(`\nPrimary verdict — Jev vs best content-only baseline (${best})\n`);
console.log(`  delta ${d.point >= 0 ? '+' : ''}${fmt(d.point)}  CI [${fmt(d.lo)}, ${fmt(d.hi)}]  ${passAuc ? 'PASS' : 'FAIL'} (rule: >0.075 and CI excludes 0)`);
console.log(`  MCC gate: Jev ${fmt(jevHard.mcc)} vs keyword ${fmt(kwHard.mcc)}  ${passMcc ? 'PASS' : 'FAIL'}`);
console.log(`\n  OVERALL: ${passAuc && passMcc ? 'SHIP' : 'DO NOT SHIP'}`);

console.log('\nDeclared confound check — within-source AUC (must survive)\n');
const within = {};
for (const fam of ['shared', 'cli', 'capture']) {
  const sub = scored.filter((x) => coarse(x.r.source) === fam);
  const pos = sub.filter((x) => isErr(x.r)).length;
  within[fam] = { n: sub.length, pos, auc: auc(sub, SCORERS['Jev isError']) };
  console.log(`  ${fam.padEnd(10)} n=${String(sub.length).padStart(3)}  pos=${String(pos).padStart(3)}  Jev AUC ${fmt(within[fam].auc)}`);
}

const kinds = {};
for (const x of scored) kinds[x.j.kind] = (kinds[x.j.kind] ?? 0) + 1;
console.log(`\nJev kind distribution: ${JSON.stringify(kinds)}`);
console.log(`Failed: ${failed}/${rows.length}   wall: ${elapsed.toFixed(1)}s   cost: $${(rows.length * COST_PER_CALL_USD).toFixed(4)}`);

mkdirSync(join(process.cwd(), 'results'), { recursive: true });
const tag = family ? `lane4-${family}-holdout` : 'lane3-all';
const outPath = join(process.cwd(), 'results', `jev-classify-${tag}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(outPath, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md Lane 3', seed, drawn: rows.length, scored: scored.length, failed,
  base_rate: scored.filter((x) => isErr(x.r)).length / scored.length,
  auc: aucTable, best_content_baseline: best, delta: d, pass_auc: passAuc,
  hard: { jev: jevHard, keyword: kwHard }, pass_mcc: passMcc, verdict: passAuc && passMcc ? 'SHIP' : 'DO NOT SHIP',
  within_source: within, kinds, elapsed_s: elapsed,
  rows: scored.map((x) => ({ id: x.r.id, source: x.r.source, label_error: isErr(x.r), jev: x.j })),
}, null, 2));
console.log(`\nWrote ${outPath}`);
db.close();
