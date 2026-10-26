#!/usr/bin/env node
// CI test-only export gate. A src/ export that no other src/ file names but a test does exists for the test, unless a file under scripts/ or benchmarks/ imports it or it is a pure function or class its own module calls (scripts/lib/export-purity.mjs).
// Any such export fails, with no baseline; package entry files are exempt.
// Usage: check-test-only-exports.mjs [--list] [--why]. --why prints the verdict on every candidate.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPurityRule } from './lib/export-purity.mjs';
import { scriptCallers } from './lib/script-callers.mjs';
import { stripComments } from './lib/source-text.mjs';

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function\*?|const|let|var|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const DIST_RE = /dist\/[\w./-]+\.js/g;
const SEAM_RE = /^_[a-z][A-Za-z0-9]*ForTests$/;
const CALLER_DIRS = ['scripts', 'benchmarks'];
const BUILD_DIRS = new Set(['node_modules', 'dist', '.git']);

function walk(dir, keep, skip = new Set(), out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name)) walk(p, keep, skip, out);
    } else if (keep(e.name)) out.push(p);
  }
  return out;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);
const idents = (text) => new Set(text.match(IDENT_RE) ?? []);
const toSrc = (dist) => dist.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
const isSource = (n) => n.endsWith('.ts') && !n.endsWith('.d.ts');
const isScript = (n) => /\.([cm]?js|[cm]?ts)$/.test(n) && !/\.d\.[cm]?ts$/.test(n);

/** The src/ files behind package.json `exports` and `bin`; a bin script is followed to the dist file it imports. */
function entryFiles(root, pkg) {
  const dists = [...JSON.stringify(pkg.exports ?? {}).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const bins = pkg.bin?.constructor === Object ? Object.values(pkg.bin) : [pkg.bin ?? []].flat();
  for (const bin of bins) {
    if (existsSync(join(root, bin))) dists.push(...(readFileSync(join(root, bin), 'utf8').match(DIST_RE) ?? []));
    else dists.push(bin);
  }
  return new Set(
    dists.filter((d) => /(^|\/)dist\//.test(d)).map((d) => toSrc(d.replace(/^\.\//, '').replace(/^.*?(dist\/)/, '$1'))),
  );
}

/** Every `src/file.ts:NAME` exported by src/ that no other src/ file names but a test does, sorted. */
function namedOnlyByTests(files, tests, entries) {
  const users = new Map();
  for (const f of files) {
    for (const id of idents(stripComments(f.text))) users.set(id, (users.get(id) ?? new Set()).add(f.file));
  }
  const inTests = new Set();
  for (const t of tests) for (const id of idents(t.text)) inTests.add(id);
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

/**
 * The verdict on every src/ export that only the tests name.
 * @param {string} [root] repo root
 * @returns {{ key: string, counted: boolean, why: string }[]} `key` is `src/file.ts:NAME`; `counted` is false for a script-called or pure export
 */
export function judgeExports(root = '.') {
  const load = (dir, keep, skip) =>
    walk(join(root, dir), keep, skip).map((p) => ({
      file: relative(root, p).replaceAll(sep, '/'),
      text: readFileSync(p, 'utf8'),
    }));
  const src = load('src', isSource);
  const candidates = namedOnlyByTests(
    src,
    load('tests', (n) => /\.(ts|tsx|mts|js|mjs)$/.test(n)),
    entryFiles(root, readJson(join(root, 'package.json'), {})),
  );
  const rule = createPurityRule(root, src);
  const called = scriptCallers(
    CALLER_DIRS.flatMap((d) => load(d, isScript, BUILD_DIRS)),
    rule.has,
    rule.resolveExport,
  );
  return candidates.map((key) => {
    if (called.has(key)) return { key, counted: false, why: 'a script or benchmark imports it' };
    const at = key.lastIndexOf(':');
    const { exempt, why } = rule.verdict(key.slice(0, at), key.slice(at + 1));
    return { key, counted: !exempt, why };
  });
}

/** `file:line name` for every src/ export that breaks the `_<verb><Thing>ForTests` scheme. */
export function seamNameViolations(root = '.') {
  const bad = [];
  for (const p of walk(join(root, 'src'), isSource)) {
    const file = relative(root, p).replaceAll(sep, '/');
    readFileSync(p, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        const name = new RegExp(EXPORT_RE.source).exec(line)?.[1];
        if (!name) return;
        const seam = name.startsWith('_') || name.endsWith('ForTests');
        if (seam && !SEAM_RE.test(name)) bad.push(`${file}:${i + 1} ${name}`);
      });
  }
  return bad;
}

function check(current) {
  if (current.length > 0) {
    console.error('Production exports that only tests use:');
    for (const e of current) console.error(`  ${e}`);
    console.error(
      'Assert through the path src uses, move the helper to tests/_helpers, or give it a production caller.',
    );
    console.error('`node scripts/check-test-only-exports.mjs --why` shows why each one is counted.');
    return 1;
  }
  console.log('Test-only export check OK: no src export is named only by tests.');
  return 0;
}

function main(args) {
  if (!existsSync('src') || !existsSync('package.json')) {
    console.error(`src/ or package.json not found in ${process.cwd()}.`);
    return 1;
  }
  const rows = judgeExports('.');
  if (args.includes('--why')) {
    for (const r of rows) console.log(`${r.counted ? 'counted' : 'not counted'}\t${r.key}\t${r.why}`);
    return 0;
  }
  const current = rows.filter((r) => r.counted).map((r) => r.key);
  if (args.includes('--list')) {
    for (const e of current) console.log(e.replace(/:([^:]+)$/, ': $1'));
    return 0;
  }
  const bad = seamNameViolations('.');
  if (bad.length > 0) {
    console.error('Test seams must be named _<verb><Thing>ForTests:');
    for (const b of bad) console.error(`  ${b}`);
    return 1;
  }
  return check(current);
}

// Guarded so the test can import judgeExports without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
