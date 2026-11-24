#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mulberry32 } from '../lib/prng.mjs';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const seeds = getArg('seeds', '21-40').split(',').flatMap((s) => {
  const m = s.match(/^(\d+)-(\d+)$/);
  return m ? Array.from({ length: Number(m[2]) - Number(m[1]) + 1 }, (_, i) => Number(m[1]) + i) : [Number(s)];
});
const B = Number(getArg('boot', '10000'));

const ENDPOINTS = {
  currentR5: { elig: () => true, val: (r) => Number(r.hit) },
  mrr: { elig: () => true, val: (r) => (r.hit ? 1 / (r.rank + 1) : 0) },
  staleIntrusionRate: { elig: (r) => r.staleEligible, val: (r) => Number(r.staleHit) },
  trapPersistenceRate: { elig: (r) => r.trapEligible, val: (r) => Number(r.trapHit) },
  contraIntrusionRate: { elig: (r) => r.contraEligible, val: (r) => Number(r.contraHit) },
  hotR5: { elig: (r) => r.hot, val: (r) => Number(r.hit) },
  cleanStaleR5: { elig: (r) => r.staleEligible, val: (r) => Number(r.hit && !r.staleHit) },
  nonStaleR5: { elig: (r) => !r.staleEligible, val: (r) => Number(r.hit) },
  cleanTrapR5: { elig: (r) => r.trapEligible, val: (r) => Number(r.hit && !r.trapHit) },
  nonTrapR5: { elig: (r) => !r.trapEligible, val: (r) => Number(r.hit) },
};
const ALIGN = ['factId', 'hot', 'staleEligible', 'trapEligible', 'contraEligible'];

function load(spec) {
  const cut = spec.lastIndexOf(':');
  const dir = spec.slice(0, cut), arm = spec.slice(cut + 1);
  return seeds.map((s) => {
    const file = path.join(dir, `${arm}-seed${s}.json`);
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    const final = run.epochs[run.epochs.length - 1];
    if (!Array.isArray(final.probes)) throw new Error(`${file}: no per-probe rows on the final epoch`);
    return { hash: run.meta.protocolHash, final };
  });
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function boot(bySeed, stat) {
  const rand = mulberry32(1);
  const n = bySeed.length;
  const draws = [];
  for (let b = 0; b < B; b++) {
    const sums = bySeed[0].map(() => 0);
    for (let i = 0; i < n; i++) {
      const groups = bySeed[Math.floor(rand() * n)];
      groups.forEach((d, g) => {
        let s = 0;
        for (let j = 0; j < d.length; j++) s += d[Math.floor(rand() * d.length)];
        sums[g] += s / d.length;
      });
    }
    draws.push(stat(sums.map((x) => x / n)));
  }
  draws.sort((x, y) => x - y);
  return [0.025, 0.975, 0.005, 0.995].map((p) => quantile(draws, p));
}

const A = load(getArg('a')), Bf = load(getArg('b'));
A.forEach((a, i) => {
  if (a.hash !== Bf[i].hash) throw new Error(`seed ${seeds[i]}: protocolHash differs between arms`);
});

function seedRows(ep) {
  const { elig, val } = ENDPOINTS[ep];
  const out = [];
  seeds.forEach((s, i) => {
    const ra = A[i].final.probes, rb = Bf[i].final.probes;
    if (ra.length !== rb.length) throw new Error(`seed ${s}: ${ra.length} vs ${rb.length} probe rows`);
    const va = [], vb = [];
    ra.forEach((r, j) => {
      if (ALIGN.some((k) => r[k] !== rb[j][k])) throw new Error(`seed ${s} row ${j}: probe rows misaligned`);
      if (elig(r)) { va.push(val(r)); vb.push(val(rb[j])); }
    });
    for (const [arm, v] of [[A, va], [Bf, vb]]) {
      if (!(ep in arm[i].final)) continue;
      const agg = arm[i].final[ep];
      const ok = v.length === 0 ? agg == null : agg != null && Math.abs(agg - mean(v)) < 1e-12;
      if (!ok) throw new Error(`seed ${s} ${ep}: probe rows disagree with the stored aggregate`);
    }
    if (va.length > 0) out.push({ a: mean(va), b: mean(vb), d: va.map((x, j) => x - vb[j]) });
  });
  return out;
}

const pp = (x) => (x * 100).toFixed(1);
const ci = ([l95, h95, l99, h99]) => `[${pp(l95)}, ${pp(h95)}] | [${pp(l99)}, ${pp(h99)}]`;
console.log(`A=${getArg('a')}  B=${getArg('b')}  seeds=${seeds[0]}..${seeds[seeds.length - 1]} (n=${seeds.length}), B=${B}`);
console.log('metric | A | B | A-B pp | 95% CI | 99% CI | seeds');
for (const ep of Object.keys(ENDPOINTS)) {
  const rs = seedRows(ep);
  if (rs.length === 0) continue;
  const delta = mean(rs.map((r) => r.a - r.b));
  const band = boot(rs.map((r) => [r.d]), ([m]) => m);
  console.log(`${ep} | ${mean(rs.map((r) => r.a)).toFixed(3)} | ${mean(rs.map((r) => r.b)).toFixed(3)} | ${pp(delta)} | ${ci(band)} | ${rs.length}`);
}

const sStarOf = (dExposed, dRest) => (dRest <= 0 ? 0 : dExposed >= 0 ? 1 : dRest / (dRest - dExposed));
for (const [name, exposedEp, restEp, count] of [
  ['superseded', 'cleanStaleR5', 'nonStaleR5', 'staleEligible'],
  ['demoted', 'cleanTrapR5', 'nonTrapR5', 'trapEligible'],
]) {
  const exposed = seedRows(exposedEp), rest = seedRows(restEp);
  if (exposed.length !== seeds.length || rest.length !== seeds.length) continue;
  const point = sStarOf(mean(exposed.map((r) => r.a - r.b)), mean(rest.map((r) => r.a - r.b)));
  const band = boot(exposed.map((r, i) => [r.d, rest[i].d]), ([dExposed, dRest]) => sStarOf(dExposed, dRest));
  const share = mean(A.map((x) => x.final[count] / x.final.activeProbes));
  console.log(`break-even ${name} share s* (A wins below it) = ${pp(point)}% ${ci(band)}; this protocol's ${count} share ${pp(share)}%`);
}
