#!/usr/bin/env node
/** Lane 10 of docs/EXPERIMENT-PROTOCOL.md, $0 no-API: does p / sqrt(tokens)
 *  fix Jev's length bias? Same K as Lane 7 (raw-p arm), same paraphrase
 *  queries, same promotion mutation; only WHICH rows get promoted differs. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch } from '../dist/search/hybrid.js';
import { buildCorpus } from '../dist/search/bm25.js';
import { loadAllEntries } from '../dist/store/entry-reads.js';

const BOOTSTRAP_DRAWS = 2000;
const ALPHA_VERDICT = 0.0167;
const ALPHA_NOMINAL = 0.05;
const RARE_DOC_MAX = 3;
const RARE_HIT_FLAG = 2;
const STOP = new Set('the a an and or but if then than that this these those is are was were be been being to of in on at for with from by as it its not no do does did done have has had will would can could should must so such when where which who whom what how why all any each other some more most only own same too very just also into over under out up down off once here there both few many much did my me your our their he she they them when after before while because'.split(' '));

const hippoRoot = join(homedir(), '.hippo');
const scoreFile = 'results/jev-classify-lane3-all-2026-09-18.json';
const NOW = new Date();

let s = 100010;
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : ' n/a ');
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
const tokens = (t) => t.split(/\s+/).filter(Boolean).length;
const toks = (t) => [...new Set(t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];
const words = (t) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);

const dir = 'evals/paraphrase';
const queries = [];
for (const fn of readdirSync(dir).filter((x) => /^queries\d+\.json$/.test(x)).sort()) {
  const part = JSON.parse(readFileSync(join(dir, fn), 'utf8'));
  queries.push(...part);
  console.error(`  ${fn}: ${part.length} queries`);
}
console.error(`merged ${queries.length} paraphrase queries\n`);

const entries = loadAllEntries(hippoRoot);
const byId = new Map(entries.map((e) => [e.id, e]));
const tokensOf = (id) => tokens(byId.get(id).content);
const lane3 = JSON.parse(readFileSync(scoreFile, 'utf8'));
const scored = new Map(lane3.rows.map((r) => [r.id, r.jev.p]));
const srcOf = new Map(lane3.rows.map((r) => [r.id, r.source]));
console.error(`corpus ${entries.length} entries, ${scored.size} scored by Jev`);

const cases = queries.filter((q) => byId.has(q.id) && q.query?.trim());
console.error(`usable cases: ${cases.length} (dropped ${queries.length - cases.length} with no matching entry)`);

const docFreq = new Map();
for (const e of entries) for (const t of toks(e.content)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);

/** Same leakage check as Lane 6/7: a shared 3-word span only counts if it also
 *  carries a distinctive word, so it flags copied wording, not shared topic. */
function sharedSpan(query, content) {
  const qw = words(query), tw = words(content).join(' ');
  const distinctive = (w) => !STOP.has(w) && (docFreq.get(w) ?? 0) <= entries.length * 0.01;
  for (let i = 0; i + 2 < qw.length; i++) {
    const g = qw.slice(i, i + 3);
    if (g.filter((w) => !STOP.has(w)).length >= 2 && g.some(distinctive) && tw.includes(g.join(' '))) return g.join(' ');
  }
  return null;
}

for (const c of cases) {
  const content = byId.get(c.id).content;
  const qt = toks(c.query);
  const ct = new Set(toks(content));
  const hit = qt.filter((t) => ct.has(t));
  c.containment = qt.length ? hit.length / qt.length : 0;
  c.rareHits = hit.filter((t) => (docFreq.get(t) ?? 0) <= RARE_DOC_MAX).length;
  c.span = sharedSpan(c.query, content);
  c.flagged = c.rareHits >= RARE_HIT_FLAG || c.span !== null;
}

const conts = cases.map((c) => c.containment).sort((a, b) => a - b);
const q = (p) => conts[Math.floor(conts.length * p)];
const flagged = cases.filter((c) => c.flagged).length;
console.error(`leakage audit: containment median ${f(q(0.5))} p75 ${f(q(0.75))} max ${f(conts[conts.length - 1] ?? 0)}, flagged ${flagged}/${cases.length} (diagnostic only, not gated)\n`);

const labelled = lane3.rows.filter((r) => byId.has(r.id));
const baseRate = labelled.filter((r) => r.label_error).length / labelled.length;
const K = Math.round(baseRate * labelled.length);
console.error(`promoting top ${K} of ${labelled.length} labelled rows (store base rate ${f(baseRate)})`);

const rawSet = new Set([...labelled].sort((a, b) => scored.get(b.id) - scored.get(a.id)).slice(0, K).map((r) => r.id));
const lenScore = (id) => scored.get(id) / Math.sqrt(tokensOf(id) || 1);
const lenSet = new Set([...labelled].sort((a, b) => lenScore(b.id) - lenScore(a.id)).slice(0, K).map((r) => r.id));

const overlap = [...rawSet].filter((id) => lenSet.has(id)).length;
const medTok = (set) => med([...set].map((id) => tokensOf(id)));
console.error(`top-K overlap: ${overlap}/${K} ids shared between raw-p and lennorm sets`);
console.error(`median tokens promoted: raw-p ${medTok(rawSet)}, lennorm ${medTok(lenSet)}\n`);

/** Only rows Jev's pick ADDS the tag to are mutated (matches jev-retrieval-ab
 *  -paraphrase.mjs:88-95); re-tagging an already-tagged row would give 4x. */
function promote(idSet) {
  const adds = [...idSet].filter((id) => !byId.get(id)?.tags.includes('error'));
  const addSet = new Set(adds);
  const mutated = entries.map((e) => (addSet.has(e.id)
    ? { ...e, tags: [...e.tags, 'error'], emotional_valence: 'negative', half_life_days: e.half_life_days * 2 }
    : e));
  return { entries: mutated, adds: adds.length, already: idSet.size - adds.length };
}

const rawP = promote(rawSet);
const lenNorm = promote(lenSet);
console.error(`raw-p arm: ${rawP.adds} newly tagged, ${rawP.already} already tagged`);
console.error(`lennorm arm: ${lenNorm.adds} newly tagged, ${lenNorm.already} already tagged`);

if (process.argv.includes('--dry')) { console.error('--dry: plumbing checked, no ranks computed, no peek taken.'); process.exit(0); }

/** Rebuilt per arm, unlike Lane 8: here tag MEMBERSHIP changes between arms,
 *  which shifts idf('error') and avgLen for every document (Lane 6/7 finding). */
const corpusBase = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const corpusRawP = buildCorpus(rawP.entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const corpusLen = buildCorpus(lenNorm.entries.map((e) => `${e.content} ${e.tags.join(' ')}`));

async function ranksFor(arm, corpus) {
  const out = [];
  for (const c of cases) {
    const res = await hybridSearch(c.query, arm, { hippoRoot, preparedCorpus: corpus, mmr: true, now: NOW });
    const i = res.findIndex((r) => r.entry.id === c.id);
    out.push({ rank: i < 0 ? Infinity : i + 1, returned: res.length });
  }
  return out;
}

console.error('\nscoring arm base');
const rBase = await ranksFor(entries, corpusBase);
console.error('scoring arm raw-p');
const rRawP = await ranksFor(rawP.entries, corpusRawP);
console.error('scoring arm lennorm');
const rLen = await ranksFor(lenNorm.entries, corpusLen);

const rows = cases.map((c, i) => ({
  id: c.id, query: c.query, source: srcOf.get(c.id) ?? null, flagged: c.flagged,
  base: rBase[i].rank, rawp: rRawP[i].rank, lennorm: rLen[i].rank,
  retBase: rBase[i].returned, retRawp: rRawP[i].returned, retLennorm: rLen[i].returned,
}));

const at = (r, k) => r.filter((x) => x <= k).length / r.length;
const METRICS = {
  'recall@budget': (r) => r.filter((x) => Number.isFinite(x)).length / r.length,
  'R@1': (r) => at(r, 1),
  'R@5': (r) => at(r, 5),
  MRR: (r) => r.reduce((a, x) => a + (Number.isFinite(x) ? 1 / x : 0), 0) / r.length,
};
const PRIMARY = 'recall@budget';

/** One resample matrix per report, shared across all 4 metrics; both CIs
 *  below read off the SAME sorted deltas, so no extra draws for the 95%. */
function report(rows, aKey, bKey, label, seed) {
  s = seed;
  const idx = [];
  for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
    const row = [];
    for (let i = 0; i < rows.length; i++) row.push(Math.floor(rng() * rows.length));
    idx.push(row);
  }
  console.log(`\n${label}  n=${rows.length}  (${aKey} vs ${bKey})\n`);
  console.log('metric          ' + aKey.padEnd(11) + bKey.padEnd(11) + 'delta      98.33% CI            95% CI (diag)        read');
  const table = {};
  for (const [name, fn] of Object.entries(METRICS)) {
    const A = rows.map((r) => r[aKey]), B = rows.map((r) => r[bKey]);
    const a = fn(A), b = fn(B);
    const ds = idx.map((row) => fn(row.map((k) => rows[k][aKey])) - fn(row.map((k) => rows[k][bKey])));
    ds.sort((x, y) => x - y);
    const ci = (alpha) => ({ lo: ds[Math.floor(ds.length * (alpha / 2))], hi: ds[Math.floor(ds.length * (1 - alpha / 2))] });
    const ci9833 = ci(ALPHA_VERDICT), ci95 = ci(ALPHA_NOMINAL);
    table[name] = { [aKey]: a, [bKey]: b, delta: a - b, ci9833, ci95 };
    const read = ci9833.lo > 0 ? `${aKey} WINS` : ci9833.hi < 0 ? `${aKey} LOSES` : 'no difference';
    console.log(`${name.padEnd(14)}  ${f(a)}  ${f(b)}  ${a - b >= 0 ? '+' : ''}${f(a - b)}  [${f(ci9833.lo)}, ${f(ci9833.hi)}]  [${f(ci95.lo)}, ${f(ci95.hi)}]  ${read}`);
  }
  return table;
}

const lenVsBase = report(rows, 'lennorm', 'base', 'CONTRAST A - lennorm vs base', 100010);
const lenVsRawp = report(rows, 'lennorm', 'rawp', 'CONTRAST B - lennorm vs raw-p (did normalising help)', 100010);

const medRetBase = med(rows.map((r) => r.retBase));
const medRetRawp = med(rows.map((r) => r.retRawp));
const medRetLen = med(rows.map((r) => r.retLennorm));
console.log(`\nmedian returned-set size: base ${medRetBase}, raw-p ${medRetRawp}, lennorm ${medRetLen}`);

const recallCI = lenVsBase[PRIMARY].ci9833;
const tie = recallCI.lo <= 0 && recallCI.hi >= 0;
const r1Loss = lenVsBase['R@1'].ci9833.hi < 0;
const pass = recallCI.lo > 0 && !r1Loss;
console.log(`\nVERDICT: ${pass ? 'SHIP' : 'DO NOT SHIP'}  (rule: lennorm vs base ${PRIMARY} CI excludes 0 upward at 98.33% AND no R@1 loss)`);
if (tie) console.log('TIE: primary 98.33% CI spans zero against base, no detectable difference at the declared alpha.');
if (r1Loss) console.log('R@1 LOSS CONFIRMED against base at 98.33%.');

mkdirSync('results', { recursive: true });
const outPath = join('results', 'jev-lennorm-ab-2026-09-18.json');
writeFileSync(outPath, JSON.stringify({
  protocol: 'docs/EXPERIMENT-PROTOCOL.md Lane 10', primary_metric: PRIMARY,
  n_queries: cases.length, labelled: labelled.length, base_rate: baseRate, K,
  promotion: {
    raw_p: { adds: rawP.adds, already_tagged: rawP.already, median_tokens: medTok(rawSet) },
    lennorm: { adds: lenNorm.adds, already_tagged: lenNorm.already, median_tokens: medTok(lenSet) },
    overlap,
  },
  leakage: { containment_median: q(0.5), containment_p75: q(0.75), flagged, rare_doc_max: RARE_DOC_MAX },
  median_returned: { base: medRetBase, raw_p: medRetRawp, lennorm: medRetLen },
  contrasts: { lennorm_vs_base: lenVsBase, lennorm_vs_rawp: lenVsRawp },
  tie, r1_loss: r1Loss, verdict: pass ? 'SHIP' : 'DO NOT SHIP',
  rows,
}, null, 2));
console.log(`\nWrote ${outPath}`);
