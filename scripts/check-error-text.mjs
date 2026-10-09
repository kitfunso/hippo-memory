#!/usr/bin/env node
// Per-file count of hand-spelled caught-error text in src/ may fall, never rise: use errorMessage() from src/log.ts.
// Usage: check-error-text.mjs [--update]. --update rewrites the baseline and refuses to raise a number.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = '.error-text-baseline.json';
const PATTERNS = [
  /\(\s*\w+\s+as\s+(?:Error|any)\s*\)\s*\.message/g,
  /\binstanceof\s+Error\s*\?\s*[\w.]+\.message\s*:/g,
  /\bString\(\s*\w*(?:[eE]rr|[eE]rror|cause)\w*\s*\)/g,
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const counts = {};
for (const f of walk('src')) {
  const file = f.replaceAll('\\', '/');
  if (file === 'src/log.ts') continue;
  const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const n = PATTERNS.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
  if (n > 0) counts[file] = n;
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
const risen = Object.entries(counts).filter(([f, n]) => n > (base[f] ?? 0));
if (process.argv.includes("--update")) {
  if (risen.length > 0) { console.error('refusing to raise a number:', risen.map(([f]) => f).join(', ')); process.exit(1); }
  writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`Wrote ${BASELINE}: ${Object.values(counts).reduce((a, b) => a + b, 0)} hits over ${Object.keys(counts).length} files.`);
} else if (risen.length > 0) {
  for (const [f, n] of risen) console.error(`${f}: ${n} hand-spelled error text (baseline ${base[f] ?? 0}); call errorMessage() from src/log.ts`);
  process.exit(1);
} else {
  console.log(`Error-text ratchet OK: ${Object.values(counts).reduce((a, b) => a + b, 0)} hits, none above ${BASELINE}.`);
}
