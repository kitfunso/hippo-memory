#!/usr/bin/env node
/** Lane 5 pre-check: if Jev tagged these rows as errors, how much would the
 *  retrieval ranking actually move? Uses hippo's own calculateStrength, so the
 *  numbers are the real ones, not a reimplementation. No API calls, no cost. */

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { calculateStrength } from '../dist/core/memory.js';

const lane4 = JSON.parse(await import('node:fs/promises').then((m) =>
  m.readFile('results/jev-classify-lane4-cli-holdout-2026-09-18.json', 'utf8')));

const db = new DatabaseSync(join(homedir(), '.hippo', 'hippo.db'));
const byId = new Map();
for (const r of db.prepare(`
  SELECT id, created, last_retrieved, retrieval_count, half_life_days,
         emotional_valence, pinned, outcome_positive, outcome_negative, outcome_score
  FROM memories`).all()) byId.set(r.id, r);

const now = new Date();
const mult = (s) => 0.5 + 0.5 * s;

const rows = [];
for (const x of lane4.rows) {
  const e = byId.get(x.id);
  if (!e) continue;
  const base = {
    ...e,
    pinned: e.pinned === 1,
    tags: [],
    half_life_days: e.half_life_days,
    emotional_valence: e.emotional_valence,
  };
  const sBase = calculateStrength(base, now);
  // The Jev arm: error tag doubles half-life (memory.ts:394) and the tag is
  // written with negative valence, which also feeds the emotional multiplier.
  const sTag = calculateStrength(
    { ...base, half_life_days: e.half_life_days * 2, emotional_valence: 'negative' }, now);
  rows.push({ id: x.id, p: x.jev.p, label: x.label_error, sBase, sTag, mBase: mult(sBase), mTag: mult(sTag) });
}

const f = (x) => x.toFixed(4);
console.log(`rows matched in live store: ${rows.length} of ${lane4.rows.length}\n`);

const clampedBase = rows.filter((r) => r.sBase >= 0.9999).length;
const clampedTag = rows.filter((r) => r.sTag >= 0.9999).length;
console.log(`at the strength clamp (1.0): baseline ${clampedBase}/${rows.length}, tagged ${clampedTag}/${rows.length}`);
console.log(`strength baseline: min ${f(Math.min(...rows.map((r) => r.sBase)))} max ${f(Math.max(...rows.map((r) => r.sBase)))}`);

// Selective arm: tag the top-K by Jev p, K = the store's own error base rate,
// declared in advance rather than tuned. Uniform tagging cannot change ranking.
const baseRate = rows.filter((r) => r.label).length / rows.length;
const K = Math.round(baseRate * rows.length);
const ranked = [...rows].sort((a, b) => b.p - a.p);
const tagSet = new Set(ranked.slice(0, K).map((r) => r.id));
console.log(`\nselective arm: tag top ${K} of ${rows.length} by Jev p (store base rate ${f(baseRate)})`);

const arm = rows.map((r) => ({ ...r, mArm: tagSet.has(r.id) ? r.mTag : r.mBase }));
const moved = arm.filter((r) => Math.abs(r.mArm - r.mBase) > 1e-9);
console.log(`multiplier actually changed for ${moved.length}/${arm.length} rows`);
if (moved.length) {
  const d = moved.map((r) => r.mArm - r.mBase);
  console.log(`  delta multiplier: min ${f(Math.min(...d))} median ${f(d.sort((a, b) => a - b)[Math.floor(d.length / 2)])} max ${f(Math.max(...d))}`);
}

function spearman(a, b) {
  const rank = (v) => { const s = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = Array(v.length); s.forEach(([, i], k) => { r[i] = k; }); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  const ma = (n - 1) / 2;
  let num = 0, da = 0, dbv = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; dbv += (rb[i] - ma) ** 2; }
  return num / Math.sqrt(da * dbv);
}
const rho = spearman(arm.map((r) => r.mBase), arm.map((r) => r.mArm));
console.log(`\nSpearman rho between baseline and Jev-arm multipliers: ${f(rho)}`);
console.log(rho > 0.99
  ? '  -> ranking is essentially unchanged; the wiring cannot move retrieval.'
  : '  -> ranking does move; a retrieval eval is warranted.');

const spread = (v) => `${f(Math.min(...v))}..${f(Math.max(...v))}`;
console.log(`\nmultiplier spread baseline ${spread(arm.map((r) => r.mBase))}, Jev arm ${spread(arm.map((r) => r.mArm))}`);
console.log(`BM25 scores vary by ~10x across a result list; a multiplier band this`);
console.log(`wide is what decides whether strength can reorder anything.`);
db.close();
