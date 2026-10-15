#!/usr/bin/env node
// CI api-reach gate. The api should reach storage through ctx.store; each runtime import in src/api of a src/store function that
// takes `hippoRoot` first is a root-keyed call that bypasses it. Existing ones sit in .api-root-calls-baseline.json and may go, never grow.
// Usage: check-api-root-calls.mjs [--list] [--update]. --update rewrites the baseline; run it only after removing imports.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASELINE = '.api-root-calls-baseline.json';
const EXPORT_RE = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^(]*>)?\(\s*hippoRoot\b/g;
const IMPORT_RE = /^import\s+(?!type\b)\{([^}]*)\}\s*from\s*['"][^'"]+['"]/gm;

function tsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p.replaceAll('\\', '/'));
  }
  return out.sort();
}

function rootKeyedNames() {
  const names = new Set();
  for (const file of tsFiles('src/store')) {
    for (const m of readFileSync(file, 'utf8').matchAll(EXPORT_RE)) names.add(m[1]);
  }
  return names;
}

/** Runtime-imported root-keyed names per src/api file: { path: n }, keys sorted. */
function findCalls(names) {
  const counts = {};
  for (const file of tsFiles('src/api')) {
    let n = 0;
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      for (const spec of m[1].split(',')) {
        const s = spec.trim();
        if (s === '' || /^type\s/.test(s)) continue;
        if (names.has(s.split(/\s+as\s+/)[0])) n += 1;
      }
    }
    if (n > 0) counts[file] = n;
  }
  return counts;
}

const current = findCalls(rootKeyedNames());
const args = process.argv.slice(2);
const total = Object.values(current).reduce((a, b) => a + b, 0);

if (args.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(current, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total} root-keyed store imports in src/api.`);
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
  console.error('src/api imports more root-keyed store functions (first parameter hippoRoot) than the baseline allows:');
  for (const [file, n] of rose) console.error(`  ${file}: ${baseline[file] ?? 'new'} -> ${n}`);
  console.error('Reach storage through ctx.store, or add a group method to the store port instead.');
  process.exit(1);
}
if (fell.length > 0) {
  console.log(`${fell.length} files dropped root-keyed imports; run \`node scripts/check-api-root-calls.mjs --update\` to lock that in.`);
}
console.log(`API root-call ratchet OK: ${total} root-keyed store imports in src/api, none above ${BASELINE}.`);
