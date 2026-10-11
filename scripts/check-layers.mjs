#!/usr/bin/env node
// CI layer gate. A src/ file imports only from its own layer or a lower one (order and the folder and root-file
// map are in layers.json). Existing upward imports sit in .layers-baseline.json and may go but never grow.
// A file under src/server/routes/ that names requireGroup or storeFor also fails: routes reach the store through src/api.
// So does a runtime import from src/cli/** or src/cli.ts into src/store or src/db, unless .cli-store-allowlist.json names it with a reason.
// Usage: check-layers.mjs [--list] [--update]. --update rewrites the baseline; it refuses to add an edge or raise a number.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { stripComments } from './lib/source-text.mjs';

const BASELINE = '.layers-baseline.json';
const MAP = 'layers.json';
const QUOTED = `['"]([^'"\\n]+)['"]`;
const IMPORT_CLAUSE = String.raw`(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)|[\w$]+)`;
const EXPORT_CLAUSE = String.raw`(type\s+)?(\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?)`;
const STATIC_RES = [
  new RegExp(String.raw`^[ \t]*import\s+${IMPORT_CLAUSE}\s*from\s*${QUOTED}`, 'gm'),
  new RegExp(String.raw`^[ \t]*export\s+${EXPORT_CLAUSE}\s*from\s*${QUOTED}`, 'gm'),
];
const SIDE_EFFECT_RE = new RegExp(String.raw`^[ \t]*import\s*${QUOTED}`, 'gm');
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

/** True when tsc erases the statement: `import type`, or a brace list whose every specifier is `type X`. */
function isTypeOnly(typeKeyword, clause) {
  if (typeKeyword) return true;
  const braces = /^\{([^}]*)\}$/.exec(clause.trim());
  if (!braces) return false;
  const specs = braces[1].split(',').map((s) => s.trim()).filter(Boolean);
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s));
}

/** Every relative import of one source as { spec, line, kind: 'runtime' | 'typeOnly' }. */
function importsOf(text) {
  const code = stripComments(text);
  const lineAt = (i) => code.slice(0, i).split('\n').length;
  const out = [];
  for (const re of STATIC_RES) {
    for (const m of code.matchAll(re)) out.push({ spec: m[3], line: lineAt(m.index), kind: isTypeOnly(m[1], m[2]) ? 'typeOnly' : 'runtime' });
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) out.push({ spec: m[1], line: lineAt(m.index), kind: 'runtime' });
  for (const m of code.matchAll(DYNAMIC_RE)) out.push({ spec: m[1], line: lineAt(m.index), kind: 'runtime' });
  return out.filter((i) => i.spec.startsWith('./') || i.spec.startsWith('../'));
}

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

/** Names every src/ folder or root file that layers.json lacks, and every entry in it that no longer exists. */
function mapProblems(map, srcDir) {
  const problems = [];
  const entries = readdirSync(srcDir, { withFileTypes: true });
  const folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const roots = entries.filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')).map((e) => e.name);
  for (const [kind, listed, actual] of [['folder', map.folders, folders], ['root file', map.rootFiles, roots]]) {
    for (const name of actual) if (!(name in listed)) problems.push(`${kind} src/${name} is not listed in ${MAP}`);
    for (const name of Object.keys(listed)) if (!actual.includes(name)) problems.push(`${kind} src/${name} is listed in ${MAP} but does not exist`);
    for (const [name, layer] of Object.entries(listed)) if (!map.order.includes(layer)) problems.push(`${kind} src/${name} names unknown layer "${layer}"`);
  }
  return problems;
}

/** Every upward import under srcDir, one per (from, to, kind), with the first line it occurs on. */
function findUpwardEdges(map, srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const layerOf = (file) => {
    const [head, ...rest] = file.split('/');
    return rest.length === 0 ? map.rootFiles[head] : map.folders[head];
  };
  const rank = (layer) => map.order.indexOf(layer);
  const edges = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    for (const { spec, line, kind } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      if (!target) continue;
      const to = rel(target);
      const [layerFrom, layerTo] = [layerOf(from), layerOf(to)];
      if (rank(layerTo) <= rank(layerFrom)) continue;
      const key = `${from}\t${to}\t${kind}`;
      if (!edges.has(key)) edges.set(key, { from, to, kind, line, layerFrom, layerTo });
    }
  }
  return [...edges.entries()].sort(([a], [b]) => byText(a, b)).map(([, e]) => e);
}

const ROUTES_DIR = 'server/routes';
const ROUTE_STORE_RE = /\b(requireGroup|storeFor)\b/;

/** Lines under src/server/routes/ that name requireGroup or storeFor: a route reaches the store through src/api, never the port. */
function findRouteStoreReaches(srcDir) {
  const root = resolve(srcDir);
  const dir = join(root, ROUTES_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of tsFiles(dir)) {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((text, i) => {
      if (ROUTE_STORE_RE.test(text)) out.push(`${relative(root, file).replaceAll('\\', '/')}:${i + 1}`);
    });
  }
  return out;
}

const CLI_ALLOWLIST = '.cli-store-allowlist.json';
const isCliFile = (file) => file === 'cli.ts' || file.startsWith('cli/');
const isStoreFile = (file) => file.startsWith('store/') || file.startsWith('db/');

/** Runtime imports from the CLI into src/store or src/db, one per (file, target), as src-relative paths. */
function findCliStoreImports(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!isCliFile(from)) continue;
    for (const { spec, line, kind } of importsOf(readFileSync(file, 'utf8'))) {
      const target = kind === 'runtime' ? resolveSpecifier(file, spec) : null;
      const to = target && rel(target);
      if (to && isStoreFile(to) && !out.has(`${from}\t${to}`)) out.set(`${from}\t${to}`, { file: from, target: to, line });
    }
  }
  return [...out.values()];
}

/** Problems with the CLI's store imports against the allowlist: unlisted imports, entries with no reason, and stale entries. */
function cliStoreProblems(srcDir) {
  const allowed = readJson(CLI_ALLOWLIST, []);
  const key = (e) => `${e.file}\t${e.target}`;
  const found = findCliStoreImports(srcDir);
  const foundKeys = new Set(found.map(key));
  const allowedKeys = new Set(allowed.map(key));
  return [
    ...found.filter((e) => !allowedKeys.has(key(e))).map((e) => `src/${e.file}:${e.line} imports src/${e.target} at runtime; call a src/api function instead`),
    ...allowed.filter((e) => !String(e.why ?? '').trim()).map((e) => `${CLI_ALLOWLIST}: src/${e.file} -> src/${e.target} gives no reason`),
    ...allowed.filter((e) => !foundKeys.has(key(e))).map((e) => `${CLI_ALLOWLIST}: src/${e.file} -> src/${e.target} matches no import; delete the entry`),
  ];
}

const edgeKey = (e) => `${e.from}\t${e.to}\t${e.kind}`;
const describe = (e) => `${e.from}:${e.line} -> ${e.to} (${e.layerFrom} -> ${e.layerTo}, ${e.kind === 'typeOnly' ? 'type' : 'runtime'})`;

const args = process.argv.slice(2);
const map = readJson(MAP, null);
if (!map || !existsSync('src')) {
  console.error(`${MAP} or src/ not found in ${process.cwd()}.`);
  process.exit(1);
}
const problems = mapProblems(map, 'src');
if (problems.length > 0) {
  console.error(`${MAP} does not match src/:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`Add the folder or file to ${MAP} under the layer it belongs to, or remove the stale entry.`);
  process.exit(1);
}

const routeReaches = findRouteStoreReaches('src');
if (routeReaches.length > 0 && !args.includes('--update') && !args.includes('--list')) {
  console.error('A route handler names requireGroup or storeFor; call a src/api function that takes the Context instead:');
  for (const r of routeReaches) console.error(`  ${r}`);
  process.exit(1);
}

const cliProblems = cliStoreProblems('src');
if (cliProblems.length > 0 && !args.includes('--list')) {
  console.error('The CLI reaches the store past src/api:');
  for (const p of cliProblems) console.error(`  ${p}`);
  process.exit(1);
}

const edges = findUpwardEdges(map, 'src');
const current = {
  runtime: edges.filter((e) => e.kind === 'runtime').length,
  typeOnly: edges.filter((e) => e.kind === 'typeOnly').length,
  rootFiles: Object.keys(map.rootFiles).length,
};
const NUMBERS = ['runtime', 'typeOnly', 'rootFiles'];
const total = `${current.runtime} runtime and ${current.typeOnly} type-only upward imports, ${current.rootFiles} root files`;
const baseline = readJson(BASELINE, null);
const was = baseline ?? { edges: [], runtime: 0, typeOnly: 0, rootFiles: 0 };
const wasKeys = new Set(was.edges.map(edgeKey));
const added = edges.filter((e) => !wasKeys.has(edgeKey(e)));
const rose = NUMBERS.filter((k) => current[k] > was[k]);

if (args.includes('--update')) {
  if (baseline && (added.length > 0 || rose.length > 0)) {
    console.error('Refusing to update: the baseline may only shrink.');
    for (const e of added) console.error(`  new: ${describe(e)}`);
    for (const k of rose) console.error(`  ${k}: ${was[k]} -> ${current[k]}`);
    process.exit(1);
  }
  const listed = edges.map(({ from, to, kind }) => ({ from, to, kind }));
  writeFileSync(BASELINE, JSON.stringify({ ...current, edges: listed }, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${total}.`);
  process.exit(0);
}

if (args.includes('--list')) {
  for (const e of edges) console.log(describe(e));
  process.exit(0);
}

if (added.length > 0 || rose.length > 0) {
  console.error('Imports go up a layer, or root files grew, past the baseline:');
  for (const e of added) console.error(`  ${describe(e)}`);
  for (const k of rose) console.error(`  ${k}: ${was[k]} -> ${current[k]}`);
  console.error(`Import only from the same layer or a lower one (order: ${map.order.join(' < ')}); move the shared piece down instead.`);
  console.error('`node scripts/check-layers.mjs --list` shows every upward import.');
  process.exit(1);
}
const currentKeys = new Set(edges.map(edgeKey));
if (was.edges.some((e) => !currentKeys.has(edgeKey(e))) || NUMBERS.some((k) => current[k] < was[k])) {
  console.log('Upward imports or root files went down; run `node scripts/check-layers.mjs --update` to lock that in.');
}
console.log(`Layer ratchet OK: ${total}, none above ${BASELINE}.`);
