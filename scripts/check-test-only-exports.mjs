#!/usr/bin/env node
// CI test-only export gate. A src/ export whose name no other src/ file mentions but a file under tests/ does exists for the test.
// Existing ones sit in .test-only-exports-baseline.json and may go but never grow; package entry files are exempt.
// Usage: check-test-only-exports.mjs [--list] [--update]. --update rewrites the baseline; it refuses to add an entry.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const BASELINE = '.test-only-exports-baseline.json';
const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const DIST_RE = /dist\/[\w./-]+\.js/g;

function walk(dir, keep, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const idents = (text) => new Set(text.match(IDENT_RE) ?? []);
const toSrc = (dist) => dist.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');

/** The src/ files behind package.json `exports` and `bin`; a bin script is followed to the dist file it imports. */
function entryFiles(pkg) {
  const dists = [...JSON.stringify(pkg.exports ?? {}).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const bins = pkg.bin?.constructor === Object ? Object.values(pkg.bin) : [pkg.bin ?? []].flat();
  for (const bin of bins) {
    if (existsSync(bin)) dists.push(...(readFileSync(bin, 'utf8').match(DIST_RE) ?? []));
    else dists.push(bin);
  }
  return new Set(dists.filter((d) => /(^|\/)dist\//.test(d)).map((d) => toSrc(d.replace(/^\.\//, '').replace(/^.*?(dist\/)/, '$1'))));
}

/** Every `src/file.ts:NAME` exported by src/ that only the tests name, sorted. */
function findTestOnly(srcDir, testsDir, entries) {
  const rel = (p) => relative(resolve('.'), p).replaceAll(sep, '/');
  const files = walk(srcDir, (n) => n.endsWith('.ts') && !n.endsWith('.d.ts')).map((p) => ({ file: rel(p), text: readFileSync(p, 'utf8') }));
  const users = new Map();
  for (const f of files) for (const id of idents(f.text)) users.set(id, (users.get(id) ?? new Set()).add(f.file));
  const inTests = new Set();
  for (const p of walk(testsDir, (n) => /\.(ts|tsx|mts|js|mjs)$/.test(n))) for (const id of idents(readFileSync(p, 'utf8'))) inTests.add(id);
  const found = [];
  for (const f of files) {
    if (entries.has(f.file)) continue;
    for (const m of f.text.matchAll(EXPORT_RE)) {
      const other = [...(users.get(m[1]) ?? [])].some((u) => u !== f.file);
      if (!other && inTests.has(m[1])) found.push(`${f.file}:${m[1]}`);
    }
  }
  return [...new Set(found)].sort(byText);
}

const args = process.argv.slice(2);
if (!existsSync('src') || !existsSync('package.json')) {
  console.error(`src/ or package.json not found in ${process.cwd()}.`);
  process.exit(1);
}
const current = findTestOnly('src', 'tests', entryFiles(readJson('package.json', {})));
const baseline = readJson(BASELINE, null);
const wasSet = new Set(baseline?.exports ?? []);
const added = current.filter((e) => !wasSet.has(e));

if (args.includes('--update')) {
  if (baseline && added.length > 0) {
    console.error('Refusing to update: the baseline may only shrink.');
    for (const e of added) console.error(`  new: ${e}`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify({ count: current.length, exports: current }, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${current.length} exports.`);
  process.exit(0);
}

if (args.includes('--list')) {
  for (const e of current) console.log(e.replace(/:([^:]+)$/, ': $1'));
  process.exit(0);
}

if (added.length > 0) {
  console.error('New production exports that only tests use:');
  for (const e of added) console.error(`  ${e}`);
  console.error('Move the helper to tests/_helpers, or give it a production caller.');
  console.error('`node scripts/check-test-only-exports.mjs --list` shows every one.');
  process.exit(1);
}
const currentSet = new Set(current);
if ([...wasSet].some((e) => !currentSet.has(e))) {
  console.log('Test-only exports went down; run `node scripts/check-test-only-exports.mjs --update` to lock that in.');
}
console.log(`Test-only export ratchet OK: ${current.length} exports, none outside ${BASELINE}.`);
