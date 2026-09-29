#!/usr/bin/env node
/** Lane 6 of docs/EXPERIMENT-PROTOCOL.md: paired retrieval A/B on PARAPHRASED
 *  queries sharing no wording with the target. Supersedes Lane 5, whose
 *  token-sampled queries let BM25 pin the target. Jev scores on disk, $0. */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hybridSearch, buildCorpus } from '../dist/search.js';
import { loadAllEntries } from '../dist/store.js';

const BOOTSTRAP_DRAWS = 2000;
const TOPN = 10;
const RARE_DOC_MAX = 3;
const RARE_HIT_FLAG = 2;
const CEILING_R5 = 0.95;
const STOP = new Set('the a an and or but if then than that this these those is are was were be been being to of in on at for with from by as it its not no do does did done have has had will would can could should must so such when where which who whom what how why all any each other some more most only own same too very just also into over under out up down off once here there both few many much did my me your our their he she they them when after before while because'.split(' '));

const hippoRoot = join(homedir(), '.hippo');
const scoreFile = 'results/jev-classify-lane3-all-2026-09-18.json';

let s = 4242;
const rng = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : ' n/a ');
const toks = (t) => [...new Set(t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];

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
const lane3 = JSON.parse(readFileSync(scoreFile, 'utf8'));
const scored = new Map(lane3.rows.map((r) => [r.id, r.jev.p]));
const srcOf = new Map(lane3.rows.map((r) => [r.id, r.source]));
console.error(`corpus ${entries.length} entries, ${scored.size} scored by Jev`);

const cases = queries.filter((q) => byId.has(q.id) && q.query?.trim());
console.error(`usable cases: ${cases.length} (dropped ${queries.length - cases.length} with no matching entry)`);

const docFreq = new Map();
for (const e of entries) for (const t of toks(e.content)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
const words = (t) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);

/** A shared 3-word span leaks only if it also carries a distinctive word:
 *  "the api key" is subject matter, "debug symbols warning" is copied wording.
 *  Calibrated on batch 1 with no outcome data seen. */
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
console.error(`\nleakage audit: containment p25 ${f(q(0.25))} median ${f(q(0.5))} p75 ${f(q(0.75))} max ${f(conts[conts.length - 1])}`);
console.error(`flagged (content 3-word span OR ${RARE_HIT_FLAG}+ tokens in <=${RARE_DOC_MAX} docs): ${flagged}/${cases.length}`);
for (const c of cases.filter((x) => x.flagged).slice(0, 8)) console.error(`  "${c.query}"  span=${JSON.stringify(c.span)} rare=${c.rareHits}`);
console.error('');

const labelled = lane3.rows.filter((r) => byId.has(r.id));
const baseRate = labelled.filter((r) => r.label_error).length / labelled.length;
const K = Math.round(baseRate * labelled.length);
const tagSet = new Set([...labelled].sort((a, b) => scored.get(b.id) - scored.get(a.id)).slice(0, K).map((r) => r.id));
console.error(`tagging top ${K} of ${labelled.length} by Jev p (store base rate ${f(baseRate)})`);

/** Stored half_life_days already carries the 2x from deriveHalfLife
 *  (memory.ts:523), so re-tagging a row that is already tagged would give 4x.
 *  Only rows Jev adds the tag to are mutated; the rest keep their real state. */
const adds = [...tagSet].filter((id) => !byId.get(id)?.tags.includes('error'));
const addSet = new Set(adds);
const jevEntries = entries.map((e) => (addSet.has(e.id)
  ? { ...e, tags: [...e.tags, 'error'], emotional_valence: 'negative', half_life_days: e.half_life_days * 2 }
  : e));
const alreadyTagged = tagSet.size - adds.length;
console.error(`  of those, ${alreadyTagged} already carry the tag (unchanged); Jev ADDS it to ${adds.length} rows`);

if (process.argv.includes('--dry')) { console.error('--dry: plumbing checked, no ranks computed, no peek taken.'); process.exit(0); }

const corpusBase = buildCorpus(entries.map((e) => `${e.content} ${e.tags.join(' ')}`));
const corpusJev = buildCorpus(jevEntries.map((e) => `${e.content} ${e.tags.join(' ')}`));

/** --opcut is Lane 7: hippo's real default 4000-token budget decides the cut
 *  (search.ts:410, a median of 28 memories), so a miss means the agent never
 *  saw it. Without the flag the budget is lifted and only rank matters. */
const OPCUT = process.argv.includes('--opcut');

async function rankOf(query, ents, corpus, targetId) {
  const opts = OPCUT
    ? { hippoRoot, preparedCorpus: corpus, mmr: true }
    : { budget: 1000000, hippoRoot, preparedCorpus: corpus, minResults: TOPN, mmr: true };
  const res = await hybridSearch(query, ents, opts);
  const i = res.findIndex((r) => r.entry.id === targetId);
  return i < 0 ? Infinity : i + 1;
}

const out = [];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  out.push({
    id: c.id, query: c.query, flagged: c.flagged, containment: c.containment,
    rareHits: c.rareHits, span: c.span, source: srcOf.get(c.id) ?? null,
    base: await rankOf(c.query, entries, corpusBase, c.id),
    jev: await rankOf(c.query, jevEntries, corpusJev, c.id),
  });
  if ((i + 1) % 50 === 0) console.error(`  ${i + 1}/${cases.length}`);
}

const at = (r, k) => r.filter((x) => x <= k).length / r.length;
const METRICS = { 'R@1': (r) => at(r, 1), 'R@5': (r) => at(r, 5), 'R@10': (r) => at(r, 10), MRR: (r) => r.reduce((a, x) => a + (Number.isFinite(x) ? 1 / x : 0), 0) / r.length };
if (OPCUT) {
  METRICS['R@28'] = (r) => at(r, 28);
  METRICS['recall@budget'] = (r) => r.filter((x) => Number.isFinite(x)).length / r.length;
}
const PRIMARY = OPCUT ? 'recall@budget' : 'R@5';

function report(rows, label) {
  const B = rows.map((o) => o.base), J = rows.map((o) => o.jev);
  console.log(`\n${label}  n=${rows.length}\n`);
  console.log('metric      baseline     Jev arm       delta        95% CI            read');
  const table = {}, cis = {};
  for (const [name, fn] of Object.entries(METRICS)) {
    const b = fn(B), j = fn(J);
    const ds = [];
    for (let d = 0; d < BOOTSTRAP_DRAWS; d++) {
      const bb = [], jj = [];
      for (let i = 0; i < rows.length; i++) { const k = Math.floor(rng() * rows.length); bb.push(rows[k].base); jj.push(rows[k].jev); }
      ds.push(fn(jj) - fn(bb));
    }
    ds.sort((a, b2) => a - b2);
    const ci = { lo: ds[Math.floor(ds.length * 0.025)], hi: ds[Math.floor(ds.length * 0.975)] };
    table[name] = { base: b, jev: j, delta: j - b };
    cis[name] = ci;
    const read = ci.lo > 0 ? 'JEV WINS' : ci.hi < 0 ? 'JEV LOSES' : 'no difference';
    console.log(`${name.padEnd(10)}  ${f(b)}      ${f(j)}     ${j - b >= 0 ? '+' : ''}${f(j - b)}   [${f(ci.lo)}, ${f(ci.hi)}]   ${read}`);
  }
  const changed = rows.filter((o) => o.base !== o.jev).length;
  const ceiling = table[PRIMARY].base > CEILING_R5;
  const pass = !ceiling && cis[PRIMARY].lo > 0 && !(cis['R@1'].hi < 0);
  console.log(`\ndiscordant pairs (rank changed at all): ${changed}/${rows.length}`);
  if (ceiling) console.log(`CEILING GATE TRIPPED: baseline ${PRIMARY} ${f(table[PRIMARY].base)} > ${CEILING_R5}. INSTRUMENT FAILURE, no verdict.`);
  else console.log(`VERDICT: ${pass ? 'SHIP' : 'DO NOT SHIP'}  (rule: ${PRIMARY} CI excludes 0 upward AND no R@1 loss)`);
  return { n: rows.length, metrics: table, ci: cis, changed, ceiling, verdict: ceiling ? 'NO VERDICT' : pass ? 'SHIP' : 'DO NOT SHIP' };
}

const LANE = OPCUT ? 'Lane 7 (operational token-budget cut)' : 'Lane 6 (rank cut)';
const primary = report(out, `${LANE} — PRIMARY, all paraphrase queries`);
const clean = out.filter((o) => !o.flagged);
const sensitivity = clean.length < out.length ? report(clean, `${LANE} — SENSITIVITY, leak-flagged pairs excluded`) : null;
if (sensitivity && sensitivity.verdict !== primary.verdict) {
  console.log(`\nPRIMARY AND SENSITIVITY DISAGREE. Declared rule: the excluded-pairs number is the verdict -> ${sensitivity.verdict}`);
}

console.log('\nper-source breakdown, families with n>=10 only (diagnostic, all under the 300-anchor floor)\n');
const fams = {};
for (const o of out) { const k = (o.source ?? 'null').replace(/^(shared|claude-memory):.*/, '$1'); (fams[k] = fams[k] || []).push(o); }
const pf = METRICS[PRIMARY];
for (const [k, rows] of Object.entries(fams).sort((a, b) => b[1].length - a[1].length)) {
  if (rows.length < 10) continue;
  const b = pf(rows.map((r) => r.base)), j = pf(rows.map((r) => r.jev));
  console.log(`  ${k.padEnd(16)} n=${String(rows.length).padStart(3)}  ${PRIMARY} ${f(b)} -> ${f(j)}  (${j - b >= 0 ? '+' : ''}${f(j - b)})`);
}

mkdirSync('results', { recursive: true });
const p = join('results', `jev-retrieval-ab-${OPCUT ? 'opcut' : 'paraphrase'}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(p, JSON.stringify({
  protocol: `docs/EXPERIMENT-PROTOCOL.md Lane ${OPCUT ? 7 : 6}`, primary_metric: PRIMARY,
  queries_merged: queries.length, tagged: K, base_rate: baseRate,
  leakage: { containment_median: q(0.5), containment_p75: q(0.75), flagged, rare_doc_max: RARE_DOC_MAX },
  primary, sensitivity, ranks: out,
}, null, 2));
console.log(`\nWrote ${p}`);
