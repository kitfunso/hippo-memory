#!/usr/bin/env node
// Checks for docs/evals/2026-09-28-e1-release-confirmation-prereg.md. r4-seeds, params and gates run before any
// compare and read no verdict: the generator, run metadata, control arms, and for M4 only whether two arms differ.
// diff and split run with the lanes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateProtocol } from './generate.mjs';

const USAGE = 'usage: confirm-check.mjs r4-seeds <from> <count> | params <dir> <arm,...> <seeds> <all|v1> <after-iso>'
  + ' | gates <dir> <seeds> | diff <dir>:<arm> <dir>:<arm> <seeds> | split <dir>:<arm> <dir>:<arm> <seeds>';
const fail = (msg) => { throw new Error(msg); };
const [mode, ...rest] = process.argv.slice(2);

// compare.mjs's seed syntax ("121-140", "1,5"), except that a bad token, a reversed range or a repeat throws.
function parseSeeds(spec = '') {
  const seeds = spec.split(',').flatMap((s) => {
    const m = s.match(/^(\d+)(?:-(\d+))?$/);
    const [lo, hi] = m ? [Number(m[1]), Number(m[2] ?? m[1])] : [];
    if (!m || hi < lo) fail(`bad seed spec: ${spec}`);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  });
  if (new Set(seeds).size !== seeds.length) fail(`repeated seed in ${spec}`);
  return seeds;
}
// A ref is <dir>:<arm>, split at the last colon so a Windows drive letter survives.
const runFile = (ref, seed) => {
  const i = ref.lastIndexOf(':');
  return JSON.parse(readFileSync(join(ref.slice(0, i), `${ref.slice(i + 1)}-seed${seed}.json`), 'utf8'));
};
const epochs = (ref, seed) => runFile(ref, seed).epochs;
const differing = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

// A hard negative's fact comes from its token, not its position: NEG{f}N{n}D####, or VAL{f}X1D#### for a v1 paraphrase (generate.mjs:258, :288).
function afterV1Share(seed, lookalikeWindow) {
  const p = generateProtocol(lookalikeWindow ? { seed, lookalikeWindow } : { seed });
  const negs = p.memories.filter((m) => m.kind === 'distractor');
  const expected = p.meta.numFacts * p.meta.distractorMultiple;
  if (negs.length !== expected) fail(`seed ${seed}: ${negs.length} hard negatives, expected ${expected}`);
  const after = negs.filter((m) => {
    const f = m.token.match(/^(?:NEG|VAL)(\d+)/)?.[1] ?? fail(`seed ${seed}: no fact index in ${m.token}`);
    return m.session > p.probes[Number(f)].versionTimeline[0].session;
  });
  return after.length / negs.length;
}

// compare.mjs's mulberry32 and one-group boot, copied because compare.mjs is a CLI with no exports.
// split's nonStaleR5 line must match compare.mjs's to the digit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
function boot(bySeed, B = 10000) {
  const rand = mulberry32(1);
  const draws = [];
  for (let b = 0; b < B; b++) {
    let sum = 0;
    for (let i = 0; i < bySeed.length; i++) {
      const d = bySeed[Math.floor(rand() * bySeed.length)];
      let s = 0;
      for (let j = 0; j < d.length; j++) s += d[Math.floor(rand() * d.length)];
      sum += s / d.length;
    }
    draws.push(sum / bySeed.length);
  }
  draws.sort((x, y) => x - y);
  return [0.025, 0.975, 0.005, 0.995].map((p) => quantile(draws, p));
}
const pp = (x) => (x * 100).toFixed(1);

if (mode === 'r4-seeds') {
  const [from, count] = rest.map(Number);
  if (!(Number.isInteger(from) && from > 0 && Number.isInteger(count) && count > 0)) fail(USAGE);
  const kept = [];
  for (let seed = from; kept.length < count; seed++) {
    if (seed >= from + 10 * count) fail(`only ${kept.length} seeds pass in ${from}..${seed - 1}`);
    const v1 = afterV1Share(seed, 'v1');
    console.log(`seed ${seed}: after-v1 share ${(100 * afterV1Share(seed)).toFixed(1)}% default, ${(100 * v1).toFixed(1)}% v1 window, ${v1 < 0.5 ? 'KEEP' : 'SKIP'}`);
    if (v1 < 0.5) kept.push(seed);
  }
  console.log(`R4 seeds: ${kept.join(',')}`);
} else if (mode === 'params') {
  // halfLife sits outside protocolHash (run.mjs:211), so compare.mjs cannot see a wrong --half-life.
  const [dir, arms, spec, window, after] = rest;
  const seeds = parseSeeds(spec);
  const lockMs = Date.parse(after);
  if (!dir || !arms || !['all', 'v1'].includes(window) || Number.isNaN(lockMs)) fail(USAGE);
  for (const arm of arms.split(',')) {
    for (const s of seeds) {
      const { meta } = runFile(`${dir}:${arm}`, s);
      const bad = [
        meta.arm !== arm && `arm ${meta.arm}`,
        meta.seed !== s && `seed ${meta.seed}`,
        meta.halfLife !== 365 && `halfLife ${meta.halfLife}`,
        meta.recencyDays !== undefined && `recencyDays ${meta.recencyDays}`,
        meta.lookalikeWindow !== (window === 'v1' ? 'v1' : undefined) && `lookalikeWindow ${meta.lookalikeWindow}`,
        !(Date.parse(meta.ranAt) > lockMs) && `ranAt ${meta.ranAt}`,
      ].filter(Boolean);
      if (bad.length > 0) fail(`${dir}:${arm} seed ${s}: ${bad.join(', ')}`);
    }
  }
  console.log(`${dir}: ${arms} on seeds ${spec}: half-life 365, window ${window}, ran after ${after}: PASS`);
} else if (mode === 'gates') {
  const [dir, spec] = rest;
  const seeds = parseSeeds(spec);
  if (seeds.length !== 20) fail(`gates read the main block's 20 seeds, got ${seeds.length}`);
  const report = (lanes, what, n) => console.log(`${lanes}: ${what} on ${n}/20 seeds (needs 18): ${n >= 18 ? 'PASS' : 'FAIL'}`);
  // A lane whose control arm fails its gate has no verdict: the workload did not exercise the mechanism. A missing value fails.
  for (const [lanes, arm, metric, bar, pass] of [
    ['C2 C4 C5', 'bm25-static', 'trapPersistenceRate', '>= 0.20', (x) => x >= 0.2],
    ['M1', 'outcome-off', 'trapPersistenceRate', '>= 0.20', (x) => x >= 0.2],
    ['M2', 'strengthen-off', 'hotR5', '<= 0.90', (x) => x <= 0.9],
    ['M3', 'decay-off', 'staleIntrusionRate', '>= 0.20', (x) => x >= 0.2],
  ]) {
    const vals = seeds.map((s) => epochs(`${dir}:${arm}`, s).at(-1)[metric]);
    const nums = vals.filter((x) => Number.isFinite(x));
    const range = `range ${Math.min(...nums).toFixed(3)} to ${Math.max(...nums).toFixed(3)}, ${vals.length - nums.length} missing`;
    report(lanes, `${arm} ${metric} ${bar} (${range})`, nums.filter(pass).length);
  }
  const moved = seeds.filter((s) => differing(epochs(`${dir}:recency-off`, s).at(-1), epochs(`${dir}:full`, s).at(-1)).length > 0);
  report('M4', 'recency-off final epoch differs from full', moved.length);
} else if (mode === 'diff') {
  const [refA, refB, spec] = rest;
  const seeds = parseSeeds(spec);
  let same = 0;
  for (const s of seeds) {
    const a = epochs(refA, s);
    const b = epochs(refB, s);
    if (a.length !== b.length) fail(`seed ${s}: ${a.length} epochs against ${b.length}`);
    const moved = a.filter((e, i) => differing(e, b[i]).length > 0).length;
    if (moved === 0) same++;
    console.log(`seed ${s}: ${moved === 0 ? 'identical in every epoch' : `${moved} of ${a.length} epochs differ; final epoch fields that differ: ${differing(a.at(-1), b.at(-1)).join(', ')}`}`);
  }
  console.log(`${refA} vs ${refB}: identical on ${same}/${seeds.length} seeds`);
} else if (mode === 'split') {
  // The paper splits currentR5 into facts that changed and facts that never did (paper.tex:434-435); compare.mjs has only the second.
  const [refA, refB, spec] = rest;
  const seeds = parseSeeds(spec);
  const rows = seeds.map((s) => {
    const [a, b] = [runFile(refA, s), runFile(refB, s)];
    if (a.meta.protocolHash !== b.meta.protocolHash) fail(`seed ${s}: protocolHash differs between arms`);
    const [ra, rb] = [a.epochs.at(-1).probes, b.epochs.at(-1).probes];
    if (ra.length !== rb.length || ra.some((r, j) => r.factId !== rb[j].factId || r.staleEligible !== rb[j].staleEligible)) {
      fail(`seed ${s}: probe rows misaligned`);
    }
    return ra.map((r, j) => ({ updated: r.staleEligible, a: Number(r.hit), b: Number(rb[j].hit) }));
  });
  console.log(`A=${refA}  B=${refB}  seeds=${seeds[0]}..${seeds.at(-1)} (n=${seeds.length}), B=10000`);
  console.log('metric | A | B | A-B pp | 95% CI | 99% CI | seeds');
  for (const [name, updated] of [['updatedR5', true], ['nonStaleR5', false]]) {
    const rs = rows.map((r) => r.filter((x) => x.updated === updated)).filter((r) => r.length > 0)
      .map((r) => ({ a: mean(r.map((x) => x.a)), b: mean(r.map((x) => x.b)), d: r.map((x) => x.a - x.b) }));
    const [l95, h95, l99, h99] = boot(rs.map((r) => r.d));
    const levels = `${mean(rs.map((r) => r.a)).toFixed(3)} | ${mean(rs.map((r) => r.b)).toFixed(3)} | ${pp(mean(rs.map((r) => r.a - r.b)))}`;
    console.log(`${name} | ${levels} | [${pp(l95)}, ${pp(h95)}] | [${pp(l99)}, ${pp(h99)}] | ${rs.length}`);
  }
} else {
  fail(USAGE);
}
