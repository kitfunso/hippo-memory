// Throwaway: sums the preload's per-file counts into one table per file, slowest first.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dir = process.argv[2];
const per = new Map();
for (const f of readdirSync(dir)) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line) continue;
    const { file, s } = JSON.parse(line);
    const key = file.includes('tests') ? file.slice(file.lastIndexOf('tests')) : file;
    const acc = per.get(key) ?? {};
    for (const [op, { n, ms }] of Object.entries(s)) {
      const o = (acc[op] ??= { n: 0, ms: 0 });
      o.n += n;
      o.ms += ms;
    }
    per.set(key, acc);
  }
}
const total = (s) => Object.values(s).reduce((a, o) => a + o.ms, 0);
const rows = [...per].sort((a, b) => total(b[1]) - total(a[1]));
const all = {};
for (const [file, s] of rows) {
  const ops = Object.entries(s)
    .sort((a, b) => b[1].ms - a[1].ms)
    .slice(0, 8)
    .map(([op, o]) => `${op}=${o.n}/${Math.round(o.ms)}ms`)
    .join(' ');
  console.log(`${file}  total=${Math.round(total(s))}ms  ${ops}`);
  for (const [op, o] of Object.entries(s)) {
    const a = (all[op] ??= { n: 0, ms: 0 });
    a.n += o.n;
    a.ms += o.ms;
  }
}
console.log('\nALL FILES');
for (const [op, o] of Object.entries(all).sort((a, b) => b[1].ms - a[1].ms))
  console.log(`  ${op.padEnd(22)} n=${String(o.n).padStart(7)}  ms=${Math.round(o.ms).toString().padStart(8)}  per=${(o.ms / o.n).toFixed(3)}`);
void relative;
