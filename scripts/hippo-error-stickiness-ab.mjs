#!/usr/bin/env node
/** Lane 8 of docs/EXPERIMENT-PROTOCOL.md. No external API: this tests HIPPO.
 *  Error-stickiness doubles half-life (memory.ts:394), lifting strength and
 *  the composite score, against a TOKEN budget (search.ts:410). Worth it? */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../dist/search/hybrid.js';
import { buildCorpus } from '../dist/search/bm25.js';
import { loadAllEntries } from '../dist/store/entry-reads.js';

const BOOTSTRAP_DRAWS = 2000;
const LENGTH_TOLERANCE = 0.25;
const PLACEBO_REPLAYS = Number(process.argv.find((a) => a.startsWith('--placebo='))?.split('=')[1] ?? 0);

const hippoRoot = join(homedir(), '.hippo');
const NOW = new Date();

let s = 90218;
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : ' n/a ');
const tokens = (t) => t.split(/\s+/).filter(Boolean).length;
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };

const queries = [];
for (const fn of readdirSync('evals/paraphrase').filter((x) => /^queries\d+\.json$/.test(x)).sort()) {
  queries.push(...JSON.parse(readFileSync(join('evals/paraphrase', fn), 'utf8')));
}

const entries = loadAllEntries(hippoRoot);
const byId = new Map(entries.map((e) => [e.id, e]));
const isError = (e) => e.tags.includes('error');
const errorRows = entries.filter(isError);
const otherRows = entries.filter((e) => !isError(e));
console.error(`store ${entries.length} entries: ${errorRows.length} error-tagged (median ${med(errorRows.map((e) => tokens(e.content)))} tokens), ${otherRows.length} other (median ${med(otherRows.map((e) => tokens(e.content)))})`);

const cases = queries.filter((q) => byId.has(q.id) && q.query?.trim())
  .map((q) => ({ ...q, stratum: isError(byId.get(q.id)) ? 'E' : 'N' }));
console.error(`queries ${cases.length} usable: stratum E ${cases.filter((c) => c.stratum === 'E').length}, stratum N ${cases.filter((c) => c.stratum === 'N').length}\n`);

/** Tags are NOT touched, so one corpus serves every arm. Lane 6/7 rebuilt it
 *  per arm and shifted idf('error') and avgLen for every document (5.7 C10). */
const corpus = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const halve = (ids) => entries.map((e) => (ids.has(e.id) ? { ...e, half_life_days: e.half_life_days / 2 } : e));
const double = (base, ids) => base.map((e) => (ids.has(e.id) ? { ...e, half_life_days: e.half_life_days * 2 } : e));

const errorIds = new Set(errorRows.map((e) => e.id));
const armOn = entries;
const armOff = halve(errorIds);

async function ranksFor(arm) {
  const out = [];
  for (const c of cases) {
    const res = await hybridSearch(c.query, arm, { hippoRoot, preparedCorpus: corpus, mmr: true, now: NOW });
    const i = res.findIndex((r) => r.entry.id === c.id);
    out.push({ rank: i < 0 ? Infinity : i + 1, returned: res.length });
  }
  return out;
}

const at = (r, k) => r.filter((x) => x <= k).length / r.length;
const METRICS = {
  'R@1': (r) => at(r, 1), 'R@5': (r) => at(r, 5), 'R@10': (r) => at(r, 10),
  'recall@budget': (r) => r.filter((x) => Number.isFinite(x)).length / r.length,
};
const PRIMARY = 'recall@budget';
let intervalCount = 0;

/** One resample matrix per report so every metric shares draws and repeated
 *  calls stay comparable (5.7 C11: the old loop advanced the stream per metric). */
function report(rows, label, seed, alpha = 0.05) {
  s = seed;
  const idx = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const row = [];
    for (let i = 0; i < rows.length; i++) row.push(Math.floor(rng() * rows.length));
    idx.push(row);
  }
  console.log(`\n${label}  n=${rows.length}\n`);
  console.log(`metric          ON (ships)   OFF          delta        ${((1 - alpha) * 100).toFixed(1)}% CI          read`);
  const table = {}, cis = {};
  for (const [name, fn] of Object.entries(METRICS)) {
    const on = fn(rows.map((o) => o.on)), off = fn(rows.map((o) => o.off));
    const ds = idx.map((row) => fn(row.map((k) => rows[k].on)) - fn(row.map((k) => rows[k].off)));
    ds.sort((a, b) => a - b);
    const ci = { lo: ds[Math.floor(ds.length * (alpha / 2))], hi: ds[Math.floor(ds.length * (1 - alpha / 2))] };
    table[name] = { on, off, delta: on - off };
    cis[name] = ci;
    intervalCount++;
    const read = ci.lo > 0 ? 'STICKINESS HELPS' : ci.hi < 0 ? 'STICKINESS HURTS' : 'no difference';
    console.log(`${name.padEnd(14)}  ${f(on)}      ${f(off)}     ${on - off >= 0 ? '+' : ''}${f(on - off)}   [${f(ci.lo)}, ${f(ci.hi)}]   ${read}`);
  }
  const changed = rows.filter((o) => o.on !== o.off).length;
  const retOn = med(rows.map((o) => o.retOn)), retOff = med(rows.map((o) => o.retOff));
  console.log(`\ndiscordant pairs: ${changed}/${rows.length}   median memories returned: ON ${retOn}, OFF ${retOff}`);
  return { n: rows.length, metrics: table, ci: cis, changed, returned: { on: retOn, off: retOff } };
}

console.error('arm ON  (incumbent, ships today)');
const rOn = await ranksFor(armOn);
console.error('arm OFF (error tag gives no half-life boost)');
const rOff = await ranksFor(armOff);

const rows = cases.map((c, i) => ({
  id: c.id, stratum: c.stratum, tokens: tokens(byId.get(c.id).content),
  on: rOn[i].rank, off: rOff[i].rank, retOn: rOn[i].returned, retOff: rOff[i].returned,
}));

const rowsE = rows.filter((r) => r.stratum === 'E'), rowsN = rows.filter((r) => r.stratum === 'N');
const primary = report(rows, 'Lane 8 PRIMARY — hippo error-stickiness, all queries', 90218);
const E = report(rowsE, 'Stratum E — target IS error-tagged (confirmatory, Bonferroni alpha 0.025)', 90218, 0.025);
const N = report(rowsN, 'Stratum N — target is NOT error-tagged (confirmatory, Bonferroni alpha 0.025)', 90218, 0.025);
report(rowsE, 'Stratum E at nominal 95% (diagnostic, for comparison only)', 90218);
report(rowsN, 'Stratum N at nominal 95% (diagnostic, for comparison only)', 90218);

const pf = METRICS[PRIMARY];
const gain = E.metrics[PRIMARY].delta, cost = N.metrics[PRIMARY].delta;
const found = gain * rowsE.length, lost = -cost * rowsN.length;
console.log('\n--- exchange rate (counts, not rates: the strata are different sizes) ---');
if (gain > 0 && cost < 0) {
  console.log(`across ${rows.length} queries stickiness FINDS ${found.toFixed(1)} error memories it would otherwise miss and LOSES ${lost.toFixed(1)} ordinary ones.`);
  console.log(`that is ${(found / lost).toFixed(2)} error memories per ordinary memory given up: it pays off if an error memory is worth more than ${(lost / found).toFixed(2)} of an ordinary one to you.`);
} else if (gain > 0 && cost >= 0) console.log(`no trade: stickiness gains on BOTH strata (E ${f(gain)}, N ${f(cost)}). Short error memories admit more, they do not evict.`);
else console.log(`no gain to trade against: E ${f(gain)}, N ${f(cost)}.`);

const lo = primary.ci[PRIMARY].lo, hi = primary.ci[PRIMARY].hi;
const verdict = hi < 0 ? 'KILL' : lo > 0 ? 'KEEP (measured gain)' : 'KEEP (tie, incumbent by parsimony)';
console.log(`\nVERDICT: ${verdict}   pooled ${PRIMARY} ${f(primary.metrics[PRIMARY].delta)} [${f(lo)}, ${f(hi)}]`);
if (N.ci[PRIMARY].hi < 0) console.log('STRATUM N LOSS CONFIRMED -> FIX branch: the boost is charged to other memories.');

let placebo = null;
if (PLACEBO_REPLAYS > 0) {
  /** Every query target is barred from BOTH boost pools. Without this the
   *  boost-other arm promotes 140 of the 173 stratum-N targets it is scored
   *  on, and beats the error arm by self-promotion alone. */
  const targetIds = new Set(cases.map((c) => c.id));
  const pool = otherRows.filter((e) => !targetIds.has(e.id)).sort((a, b) => tokens(a.content) - tokens(b.content));
  const used = new Set(); const pairs = [];
  console.error(`placebo pools exclude all ${targetIds.size} query targets: ${pool.length} non-error candidates available`);
  for (const t of errorRows.filter((e) => !targetIds.has(e.id)).sort((a, b) => tokens(a.content) - tokens(b.content))) {
    const tl = tokens(t.content);
    let best = null, bestGap = Infinity;
    for (const p of pool) {
      if (used.has(p.id)) continue;
      const gap = Math.abs(tokens(p.content) - tl);
      if (gap < bestGap) { bestGap = gap; best = p; }
      if (tokens(p.content) > tl && best) break;
    }
    if (best && bestGap <= Math.max(1, tl * LENGTH_TOLERANCE)) { used.add(best.id); pairs.push({ gap: bestGap, err: t.id, oth: best.id }); }
  }
  const medGap = med(pairs.map((p) => p.gap));
  const medErrLen = med(errorRows.map((e) => tokens(e.content)));
  const usable = medGap <= medErrLen * LENGTH_TOLERANCE;
  console.log(`\n--- placebo: ${pairs.length} length-matched pairs, median |gap| ${medGap} tokens vs ${medErrLen} median error length -> ${usable ? 'USABLE' : 'TOO WEAK, diagnostic only'}`);

  /** Both arms boost the SAME COUNT at MATCHED LENGTHS and differ only in
   *  errorness, so length cannot explain a gap between them. Replays share
   *  ~70% of their pairs, so these are far fewer than 20 effective draws. */
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const take = Math.floor(pairs.length * 0.7);
  const errD = [], othD = [];
  for (let r = 0; r < PLACEBO_REPLAYS; r++) {
    const sub = shuffle([...pairs]).slice(0, take);
    const nIdx = cases.map((c, i) => [c, i]).filter(([c]) => c.stratum === 'N');
    const armErr = await ranksFor(double(armOff, new Set(sub.map((p) => p.err))));
    const armOth = await ranksFor(double(armOff, new Set(sub.map((p) => p.oth))));
    const base = pf(nIdx.map(([, i]) => rOff[i].rank));
    errD.push(pf(nIdx.map(([, i]) => armErr[i].rank)) - base);
    othD.push(pf(nIdx.map(([, i]) => armOth[i].rank)) - base);
    console.error(`  replay ${r + 1}/${PLACEBO_REPLAYS}: stratum N delta, boost-error ${f(errD[r])}  boost-matched-other ${f(othD[r])}`);
  }
  const sorted = (a) => [...a].sort((x, y) => x - y);
  const pct = (a, p) => sorted(a)[Math.floor(a.length * p)];
  placebo = { pairs: pairs.length, subsample: take, median_gap: medGap, usable, replays: PLACEBO_REPLAYS,
    boost_error: { median: med(errD), p5: pct(errD, 0.05), p95: pct(errD, 0.95) },
    boost_matched_other: { median: med(othD), p5: pct(othD, 0.05), p95: pct(othD, 0.95) }, errD, othD };
  console.log(`boosting ${take} ERROR rows            -> stratum N delta median ${f(med(errD))}  [p5 ${f(pct(errD, 0.05))}, p95 ${f(pct(errD, 0.95))}]`);
  console.log(`boosting ${take} LENGTH-MATCHED others -> stratum N delta median ${f(med(othD))}  [p5 ${f(pct(othD, 0.05))}, p95 ${f(pct(othD, 0.95))}]`);
  const sep = med(errD) - med(othD);
  console.log(sep < 0 && med(errD) < pct(othD, 0.05)
    ? `Boosting error rows costs stratum N ${f(-sep)} MORE than boosting the same number of equally long non-error rows. Errorness carries the loss, not length.`
    : `The two arms overlap: at matched length and count, boosting error rows is not distinguishable from boosting anything else. The mechanism is LENGTH and COUNT, not errorness.`);
}

console.log(`\nintervals computed this lane: ${intervalCount} (declared primary is one of them; the rest are diagnostic)`);
mkdirSync('results', { recursive: true });
const p = join('results', `hippo-error-stickiness-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(p, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md Lane 8', primary_metric: PRIMARY, verdict,
  n: rows.length, primary, stratum_E: E, stratum_N: N, exchange: { gain, cost }, placebo,
  intervals: intervalCount, rows,
}, null, 2));
console.log(`Wrote ${p}`);
