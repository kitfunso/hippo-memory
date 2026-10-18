#!/usr/bin/env node
// CI config-read gate. Only a surface-layer file (layers.json) and src/core/config.ts read config.json through loadConfig;
// api code reads ctx.config, and domain, store and base code takes the config from its caller. Files that still do sit in
// .config-reads-baseline.json and may go, never grow.
// Usage: check-config-reads.mjs [--list] [--update]. --update rewrites the baseline; run it only after removing reads.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFacts } from './lib/ts-facts.mjs';

const BASELINE = '.config-reads-baseline.json';
const MAP = 'layers.json';
const ALLOWED = new Set(['src/core/config.ts']);

function tsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p.replaceAll('\\', '/'));
  }
  return out.sort();
}

/** The layer of a path under src/: its root file's, else its top folder's. */
function layerOf(map, file) {
  const [head, ...rest] = file.slice('src/'.length).split('/');
  return rest.length === 0 ? map.rootFiles[head] : map.folders[head];
}

/** loadConfig( call sites per non-surface src file: { path: n }. */
function findReads(map) {
  const counts = {};
  for (const file of tsFiles('src')) {
    if (ALLOWED.has(file) || layerOf(map, file) === 'surface') continue;
    const text = readFileSync(file, 'utf8');
    // A loadConfig call cannot exist without its text, so other files skip the parse.
    const n = text.includes('loadConfig') ? readFacts(text, file, ['calls']).calls.filter((c) => c.callee.split('.').at(-1) === 'loadConfig').length : 0;
    if (n > 0) counts[file] = n;
  }
  return counts;
}

const current = findReads(JSON.parse(readFileSync(MAP, 'utf8')));
const args = process.argv.slice(2);
const total = Object.values(current).reduce((a, b) => a + b, 0);

if (args.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total} config reads outside the surface layer.`);
  process.exit(0);
}
if (args.includes('--list')) {
  for (const [file, n] of Object.entries(current)) console.log(`${n}\t${file}`);
  process.exit(0);
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const rose = Object.entries(current).filter(([file, n]) => n > (baseline[file] ?? 0));
const fell = Object.entries(baseline).filter(([file, n]) => (current[file] ?? 0) < n);
if (rose.length > 0) {
  console.error('Code outside the surface layer reads config.json (loadConfig) more than the baseline allows:');
  for (const [file, n] of rose) console.error(`  ${file}: ${baseline[file] ?? 'new'} -> ${n}`);
  console.error('Take the config as a parameter from the caller (src/api code: ctx.config).');
  process.exit(1);
}
if (fell.length > 0) {
  console.log(`${fell.length} files dropped config reads; run \`node scripts/check-config-reads.mjs --update\` to lock that in.`);
}
console.log(`Config-read ratchet OK: ${total} reads outside the surface layer, none above ${BASELINE}.`);
