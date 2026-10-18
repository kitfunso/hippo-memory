#!/usr/bin/env node
// CI layer gate. A src/ file imports only from its own layer or a lower one (order and the folder and root-file
// map are in layers.json). Any upward import, runtime or type-only, fails; there is no baseline of edges.
// .layers-baseline.json holds one number, the cap on root files in layers.json, which may fall but never rise.
// A file under src/server/routes/ that names requireGroup or storeFor also fails: routes reach the store through src/api.
// So does a runtime import from src/cli/** or src/cli.ts into src/store or src/db, unless .cli-store-allowlist.json names it with a reason.
// So does a runtime import from src/api/**, src/connectors/** or src/mcp/** into src/store/sqlite/**, unless SQLITE_PINNED names it with a reason: they take the store from the Context.
// layers.json `dbReach` names the folders that reach the db layer only through the store, and each import that may stay, with why.
// Usage: check-layers.mjs [--list] [--update]. --update lowers the root-file cap; it refuses to raise it.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { isLocalSpec, readFacts } from './lib/ts-facts.mjs';

const BASELINE = '.layers-baseline.json';
const MAP = 'layers.json';

// Several checks below read the same files, so each source is parsed once.
const IMPORT_CACHE = new Map();

/** Every relative import of one source as { spec, line, kind: 'runtime' | 'typeOnly', names }. */
function importsOf(text) {
  let found = IMPORT_CACHE.get(text);
  if (!found) {
    found = readFacts(text, 'file.ts', ['imports', 'dynamic'])
      .imports.filter((i) => isLocalSpec(i.spec))
      .map((i) => ({ spec: i.spec, line: i.line, kind: i.typeOnly ? 'typeOnly' : 'runtime', names: i.names }));
    IMPORT_CACHE.set(text, found);
  }
  return found;
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
  const roots = entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts'))
    .map((e) => e.name);
  for (const [kind, listed, actual] of [
    ['folder', map.folders, folders],
    ['root file', map.rootFiles, roots],
  ]) {
    for (const name of actual) if (!(name in listed)) problems.push(`${kind} src/${name} is not listed in ${MAP}`);
    for (const name of Object.keys(listed)) {
      if (!actual.includes(name)) problems.push(`${kind} src/${name} is listed in ${MAP} but does not exist`);
    }
    for (const [name, layer] of Object.entries(listed)) {
      if (!map.order.includes(layer)) problems.push(`${kind} src/${name} names unknown layer "${layer}"`);
    }
  }
  return problems;
}

/** The layer of a path relative to src/: its root file's, else its top folder's. */
function layerIn(map, file) {
  const [head, ...rest] = file.split('/');
  return rest.length === 0 ? map.rootFiles[head] : map.folders[head];
}

/** Every upward import under srcDir, one per (from, to, kind), with the first line it occurs on. */
function findUpwardEdges(map, srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const layerOf = (file) => layerIn(map, file);
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
const ROUTE_STORE_NAMES = new Set(['requireGroup', 'storeFor']);

/** Lines under src/server/routes/ that name requireGroup or storeFor: a route reaches the store through src/api, never the port. */
function findRouteStoreReaches(srcDir) {
  const root = resolve(srcDir);
  const dir = join(root, ROUTES_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of tsFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    // An identifier cannot exist without its text, so a route file with neither name skips the parse.
    if (![...ROUTE_STORE_NAMES].some((name) => text.includes(name))) continue;
    const lines = new Set(
      readFacts(text, 'file.ts', ['identifiers'])
        .identifiers.filter((id) => ROUTE_STORE_NAMES.has(id.name))
        .map((id) => id.line),
    );
    for (const line of [...lines].sort((x, y) => x - y)) {
      out.push(`${relative(root, file).replaceAll('\\', '/')}:${line}`);
    }
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
      if (to && isStoreFile(to) && !out.has(`${from}\t${to}`)) {
        out.set(`${from}\t${to}`, { file: from, target: to, line });
      }
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
    ...found
      .filter((e) => !allowedKeys.has(key(e)))
      .map((e) => `src/${e.file}:${e.line} imports src/${e.target} at runtime; call a src/api function instead`),
    ...allowed
      .filter((e) => !String(e.why ?? '').trim())
      .map((e) => `${CLI_ALLOWLIST}: src/${e.file} -> src/${e.target} gives no reason`),
    ...allowed
      .filter((e) => !foundKeys.has(key(e)))
      .map((e) => `${CLI_ALLOWLIST}: src/${e.file} -> src/${e.target} matches no import; delete the entry`),
  ];
}

const SQLITE_FROM = ['api/', 'connectors/', 'dashboard/', 'mcp/'];
const SQLITE_DIR = 'store/sqlite/';
// Each runtime import that may stay, as src-relative paths with why.
const SQLITE_PINNED = [];

/** Runtime imports from src/api, src/connectors, src/dashboard or src/mcp into src/store/sqlite, one per (file, target), as src-relative paths. */
function findSqliteReaches(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!SQLITE_FROM.some((dir) => from.startsWith(dir))) continue;
    for (const { spec, line, kind } of importsOf(readFileSync(file, 'utf8'))) {
      const target = kind === 'runtime' ? resolveSpecifier(file, spec) : null;
      const to = target && rel(target);
      if (to?.startsWith(SQLITE_DIR) && !out.has(`${from}\t${to}`)) {
        out.set(`${from}\t${to}`, { file: from, target: to, line });
      }
    }
  }
  return [...out.values()];
}

/** Unpinned SQLite imports, then pinned entries whose file still exists but no longer imports the target. */
function sqliteReachProblems(srcDir) {
  const key = (e) => `${e.file}\t${e.target}`;
  const found = findSqliteReaches(srcDir);
  const foundKeys = new Set(found.map(key));
  const pinnedKeys = new Set(SQLITE_PINNED.map(key));
  return [
    ...found
      .filter((e) => !pinnedKeys.has(key(e)))
      .map(
        (e) => `src/${e.file}:${e.line} imports src/${e.target} at runtime; take the store from the Context instead`,
      ),
    ...SQLITE_PINNED.filter((e) => existsSync(join(srcDir, e.file)) && !foundKeys.has(key(e))).map(
      (e) => `pinned: src/${e.file} no longer imports src/${e.target}; delete the entry`,
    ),
  ];
}

/** Imports from `dbReach.layer` in a `dbReach.from` folder that `dbReach.allowed` does not name, then allowed entries nothing uses or that give no why. */
function findDbReaches(map, srcDir) {
  const rule = map.dbReach;
  if (!rule) return { reaches: [], stale: [] };
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const allowed = rule.allowed ?? {};
  const used = new Map();
  const reaches = [];
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!rule.from.includes(from.split('/')[0])) continue;
    for (const { spec, line, names } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      if (!target || layerIn(map, rel(target)) !== rule.layer) continue;
      for (const name of names) {
        if (!used.has(from)) used.set(from, new Set());
        used.get(from).add(name);
        if (!(allowed[from]?.names ?? []).includes(name)) {
          reaches.push(`${from}:${line} imports ${name} from ${rel(target)}`);
        }
      }
    }
  }
  const stale = [];
  for (const [file, entry] of Object.entries(allowed)) {
    if (!entry.why?.trim()) stale.push(`${file} gives no why`);
    for (const name of entry.names ?? []) {
      if (!used.get(file)?.has(name)) stale.push(`${file} no longer imports ${name}`);
    }
  }
  return { reaches, stale };
}

const describe = (e) =>
  `${e.from}:${e.line} -> ${e.to} (${e.layerFrom} -> ${e.layerTo}, ${e.kind === 'typeOnly' ? 'type' : 'runtime'})`;

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
  console.error(
    'A route handler names requireGroup or storeFor; call a src/api function that takes the Context instead:',
  );
  for (const r of routeReaches) console.error(`  ${r}`);
  process.exit(1);
}

const cliProblems = cliStoreProblems('src');
if (cliProblems.length > 0 && !args.includes('--list')) {
  console.error('The CLI reaches the store past src/api:');
  for (const p of cliProblems) console.error(`  ${p}`);
  process.exit(1);
}

const sqliteProblems = sqliteReachProblems('src');
if (sqliteProblems.length > 0 && !args.includes('--list')) {
  console.error(
    'The api, connectors, dashboard or mcp layer reaches the SQLite adapter; a composition root builds the store and hands it down in the Context:',
  );
  for (const p of sqliteProblems) console.error(`  ${p}`);
  process.exit(1);
}

const dbReach = findDbReaches(map, 'src');
if (dbReach.reaches.length + dbReach.stale.length > 0 && !args.includes('--update') && !args.includes('--list')) {
  const layer = map.dbReach.layer;
  for (const r of dbReach.reaches) console.error(`  ${r}`);
  for (const s of dbReach.stale) console.error(`  ${MAP} dbReach.allowed: ${s}`);
  console.error(
    `src/${map.dbReach.from.join(', src/')} reach the ${layer} layer through a src/store function and the store errors in src/store/port.ts.`,
  );
  console.error(
    `Move the ${layer} work into src/store; an import that must stay goes in ${MAP} dbReach.allowed with its why, and an unused one leaves it.`,
  );
  process.exit(1);
}

const edges = findUpwardEdges(map, 'src');
const rootFiles = Object.keys(map.rootFiles).length;
const cap = readJson(BASELINE, { rootFiles: 0 }).rootFiles;

if (args.includes('--update')) {
  if (rootFiles > cap) {
    console.error(`Refusing to update: root files ${cap} -> ${rootFiles}; the cap may only fall.`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify({ rootFiles }, null, 2) + '\n');
  console.log(`Wrote ${BASELINE}: ${rootFiles} root files.`);
  process.exit(0);
}

if (args.includes('--list')) {
  for (const e of edges) console.log(describe(e));
  process.exit(0);
}

if (edges.length > 0 || rootFiles > cap) {
  console.error('Imports go up a layer, or root files grew past the cap:');
  for (const e of edges) console.error(`  ${describe(e)}`);
  if (rootFiles > cap) console.error(`  rootFiles: ${cap} -> ${rootFiles}`);
  console.error(
    `Import only from the same layer or a lower one (order: ${map.order.join(' < ')}); move the shared piece down instead.`,
  );
  console.error('`node scripts/check-layers.mjs --list` shows every upward import.');
  process.exit(1);
}
if (rootFiles < cap) {
  console.log('Root files went down; run `node scripts/check-layers.mjs --update` to lock that in.');
}
console.log(`Layer order OK: no upward imports, ${rootFiles} root files (cap ${cap} in ${BASELINE}).`);
