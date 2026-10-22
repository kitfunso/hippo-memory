#!/usr/bin/env node
// CI layer gate. A src/ file imports only from its own layer or a lower one (order and the folder and root-file
// map are in layers.json). Any upward import, runtime or type-only, fails; there is no baseline of edges.
// .layers-baseline.json holds one number, the cap on root files in layers.json, which may fall but never rise.
// A file under src/surface/server/routes/ that names requireGroup or storeFor also fails: routes reach the store through src/api.
// So does a runtime import from src/surface/cli/** or src/cli.ts into src/store or src/db, unless .cli-store-allowlist.json names it with a reason.
// layers.json `adapter`: any import, re-export or import() (type-only too) into its folder from a file outside it and its
// one `root` fails, as does a root import past its `doors`, a sqliteStoreOn name outside them, and any identifier
// or string naming SQLite in an `unnamedIn` layer: every other file takes its store, and its errors, through the port.
// So does a runtime import from src/surface/cli/** or src/surface/mcp/** into src/domain, with no list: commands reach business logic through src/api.
// So does any import from src/api/** into src/store other than the port (port.ts, port-groups.ts, port/**) and local/**, which the next rule covers: the api reads the store through the port and takes shared rules from src/base.
// So does any import from src/api/** or src/domain/** into src/store/local/**, with no list, any isLocalStore there, and any hippoRoot in src/api/**: both read the store through its port groups.
// So does any import, runtime or type-only, from src/surface/dashboard/** into src/store, src/db or src/surface/cli: the dashboard reads through src/api, with no baseline.
// layers.json `apart`: a folder named there imports nothing, type-only too, from the folders it lists (the api reads
// the outside services from its Context, never from src/infra). `barrels`: each root file named there imports and
// re-exports only from its folder (src/index.ts from src/entry).
// layers.json `dbReach`: every file outside the db layer and `dbReach.through` (the store) reaches the db layer through the store; `allowed` names each import that may stay, with why.
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

const ROUTES_DIR = 'surface/server/routes';
const ROUTE_STORE_NAMES = new Set(['requireGroup', 'storeFor']);

/** Lines under src/surface/server/routes/ that name requireGroup or storeFor: a route reaches the store through src/api, never the port. */
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
const isCliFile = (file) => file === 'cli.ts' || file.startsWith('surface/cli/');
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

const isCommandFile = (file) => file.startsWith('surface/cli/') || file.startsWith('surface/mcp/');

/** Runtime imports from the CLI or MCP commands into src/domain, one per (file, target), as src-relative paths. */
function findSurfaceDomainImports(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!isCommandFile(from)) continue;
    for (const { spec, line, kind } of importsOf(readFileSync(file, 'utf8'))) {
      const target = kind === 'runtime' ? resolveSpecifier(file, spec) : null;
      const to = target && rel(target);
      if (to?.startsWith('domain/') && !out.has(`${from}\t${to}`)) {
        out.set(`${from}\t${to}`, { file: from, target: to, line });
      }
    }
  }
  return [...out.values()];
}

/** Every runtime import of src/domain from a CLI or MCP command; no list excuses one. */
function surfaceDomainProblems(srcDir) {
  return findSurfaceDomainImports(srcDir).map(
    (e) => `src/${e.file}:${e.line} imports src/${e.target} at runtime; call a src/api function instead`,
  );
}

const API_PORT_FILES = new Set(['store/port.ts', 'store/port-groups.ts']);

/** Imports from src/api into a src/store file that is not part of the port, one per (file, target), runtime or type-only. */
function findApiStoreReaches(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!from.startsWith('api/')) continue;
    for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      const to = target && rel(target);
      const outsidePort =
        to?.startsWith('store/') &&
        !API_PORT_FILES.has(to) &&
        !to.startsWith('store/port/') &&
        !to.startsWith('store/local/');
      const key = `${from}\t${to}`;
      if (outsidePort && !out.has(key)) out.set(key, { file: from, target: to, line });
    }
  }
  return [...out.values()];
}

const LOCAL_DIR = 'store/local/';

/** Imports from src/api or src/domain into src/store/local, runtime or type-only, one per (file, target). */
function findLocalImports(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!from.startsWith('api/') && !from.startsWith('domain/')) continue;
    for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      const to = target && rel(target);
      const key = `${from}\t${to}`;
      if (to?.startsWith(LOCAL_DIR) && !out.has(key)) out.set(key, { file: from, target: to, line });
    }
  }
  return [...out.values()];
}

/** `file:line` of each isLocalStore in src/api or src/domain, and each hippoRoot in src/api. */
function findLocalNames(srcDir) {
  const root = resolve(srcDir);
  const out = [];
  for (const file of tsFiles(root)) {
    const from = relative(root, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    const banned = new Set();
    if (/^(api|domain)\//.test(from) && text.includes('isLocalStore')) banned.add('isLocalStore');
    if (from.startsWith('api/') && text.includes('hippoRoot')) banned.add('hippoRoot');
    if (banned.size === 0) continue;
    for (const id of readFacts(text, 'file.ts', ['identifiers']).identifiers.filter((i) => banned.has(i.name))) {
      out.push(
        id.name === 'hippoRoot'
          ? `src/${from}:${id.line} names hippoRoot; read what the folder gave from a port method`
          : `src/${from}:${id.line} names isLocalStore; test the optional group by its property`,
      );
    }
  }
  return out;
}

/** Every local-store import from src/api or src/domain, then the banned names. */
function localReachProblems(srcDir) {
  return [
    ...findLocalImports(srcDir).map(
      (e) => `src/${e.file}:${e.line} imports src/${e.target}; read it through a port group`,
    ),
    ...findLocalNames(srcDir),
  ];
}

// The store built on an adapter's own handles is the adapter's; every other file takes the port from a root.
const ADAPTER_STORE_NAMES = new Set(['sqliteStoreOn']);
const SQLITE_WORD = /sqlite/i;

/** Imports, re-exports and import() calls, type-only too, from a file outside the adapter's folder into it, one per
 * (file, target). */
function findAdapterReaches(rule, srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const dir = `${rule.folder}/`;
  const out = new Map();
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (from.startsWith(dir)) continue;
    for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      const to = target && rel(target);
      const key = `${from}\t${to}`;
      if (to?.startsWith(dir) && !out.has(key)) out.set(key, { file: from, target: to, line });
    }
  }
  return [...out.values()];
}

/** `file:line` of each sqliteStoreOn outside the adapter and its root, and of each identifier or string naming SQLite
 * in an `unnamedIn` layer. */
function findAdapterNames(map, rule, srcDir) {
  const root = resolve(srcDir);
  const out = [];
  for (const file of tsFiles(root)) {
    const from = relative(root, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    if (from.startsWith(`${rule.folder}/`) || from === rule.root || !SQLITE_WORD.test(text)) continue;
    const unnamed = (rule.unnamedIn ?? []).includes(layerIn(map, from));
    const { identifiers, strings } = readFacts(text, 'file.ts', ['identifiers', 'strings']);
    for (const id of identifiers) {
      const named = ADAPTER_STORE_NAMES.has(id.name) || (unnamed && SQLITE_WORD.test(id.name));
      const hint = ADAPTER_STORE_NAMES.has(id.name) ? '; take the port from a root instead' : '';
      if (named) out.push(`src/${from}:${id.line} names ${id.name}${hint}`);
    }
    // A module path is the import rule's to report.
    const specs = new Set(importsOf(text).map((i) => i.spec));
    const named = (unnamed ? strings : []).filter((str) => SQLITE_WORD.test(str.text) && !specs.has(str.text));
    for (const str of named) out.push(`src/${from}:${str.line} says SQLite in a string`);
  }
  return out;
}

/** A root that is gone or no longer imports the adapter, so `adapter.root` names the wrong file. */
function staleAdapterRoot(rule, srcDir, found) {
  if (!existsSync(join(srcDir, rule.root))) return [`${MAP} adapter.root: src/${rule.root} does not exist`];
  if (found.some((e) => e.file === rule.root)) return [];
  return [`${MAP} adapter.root: src/${rule.root} no longer imports src/${rule.folder}`];
}

/** Adapter imports outside its root, root imports past the doors, adapter names, then a stale root. */
function adapterProblems(map, srcDir) {
  const rule = map.adapter;
  if (!rule) return [];
  const found = findAdapterReaches(rule, srcDir);
  const doors = new Set(rule.doors ?? []);
  return [
    ...found
      .filter((e) => e.file !== rule.root)
      .map(
        (e) => `src/${e.file}:${e.line} imports src/${e.target}; take the store from src/${rule.root} or the Context`,
      ),
    ...found
      .filter((e) => e.file === rule.root && !doors.has(e.target))
      .map((e) => `src/${e.file}:${e.line} imports src/${e.target} past the adapter's doors in ${MAP}`),
    ...findAdapterNames(map, rule, srcDir),
    ...staleAdapterRoot(rule, srcDir, found),
  ];
}

const DASHBOARD_BARRED = ['store/', 'db/', 'surface/cli/', 'cli.ts'];

/** Imports from src/surface/dashboard into src/store, src/db or src/surface/cli, runtime or type-only, as `file:line imports target`. */
function findDashboardReaches(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = [];
  for (const file of tsFiles(root)) {
    const from = rel(file);
    if (!from.startsWith('surface/dashboard/')) continue;
    for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      const to = target && rel(target);
      if (to && DASHBOARD_BARRED.some((barred) => to === barred || to.startsWith(barred))) {
        out.push(`src/${from}:${line} imports src/${to}`);
      }
    }
  }
  return out;
}

/** `file:line` of each import from a folder `apart` lists into a folder it keeps apart from, type-only too. */
function findApartReaches(map, srcDir) {
  const apart = map.apart ?? {};
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = [];
  for (const file of tsFiles(root)) {
    const from = rel(file);
    const barred = apart[from.split('/')[0]];
    if (!barred || !from.includes('/')) continue;
    for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      const to = target && rel(target);
      if (to && barred.some((folder) => to.startsWith(`${folder}/`))) out.push(`src/${from}:${line} imports src/${to}`);
    }
  }
  return out;
}

/** `file:line` of each import or re-export in a `barrels` root file from outside its folder, and each listed file that
 * is gone. */
function findBarrelReaches(map, srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const out = [];
  for (const [name, folder] of Object.entries(map.barrels ?? {})) {
    const file = join(root, name);
    if (!existsSync(file)) {
      out.push(`${MAP} barrels: src/${name} does not exist`);
      continue;
    }
    for (const { spec, line } of importsOf(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      const to = target ? rel(target) : spec;
      if (!to.startsWith(`${folder}/`)) {
        out.push(`src/${name}:${line} reaches ${to}; re-export it from a src/${folder} barrel`);
      }
    }
  }
  return out;
}

/** Imports from `dbReach.layer` in a file outside it and `dbReach.through` that `dbReach.allowed` does not name, then allowed entries nothing uses or that give no why. */
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
    if ([rule.layer, rule.through].includes(layerIn(map, from))) continue;
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

const surfaceDomain = surfaceDomainProblems('src');
if (surfaceDomain.length > 0 && !args.includes('--list')) {
  console.error('A CLI or MCP command imports src/domain past src/api:');
  for (const p of surfaceDomain) console.error(`  ${p}`);
  process.exit(1);
}

const sqliteProblems = adapterProblems(map, 'src');
if (sqliteProblems.length > 0 && !args.includes('--list')) {
  console.error(
    `A file reaches or names the SQLite adapter past src/${map.adapter.root}; the root builds the store and hands it down:`,
  );
  for (const p of sqliteProblems) console.error(`  ${p}`);
  process.exit(1);
}

const dashboardReaches = findDashboardReaches('src');
if (dashboardReaches.length > 0 && !args.includes('--list')) {
  console.error('The dashboard imports the store or the CLI; read and write through a src/api function instead:');
  for (const r of dashboardReaches) console.error(`  ${r}`);
  process.exit(1);
}

const apiStoreReaches = findApiStoreReaches('src');
if (apiStoreReaches.length > 0 && !args.includes('--list')) {
  console.error(
    'The api imports a store module past the port; read it through the port, or move the shared rule to src/base:',
  );
  for (const e of apiStoreReaches) console.error(`  src/${e.file}:${e.line} imports src/${e.target}`);
  process.exit(1);
}

const localProblems = localReachProblems('src');
if (localProblems.length > 0 && !args.includes('--list')) {
  console.error('The api or domain reaches the local store past its port groups, or the api names the folder:');
  for (const p of localProblems) console.error(`  ${p}`);
  process.exit(1);
}

const apartReaches = findApartReaches(map, 'src');
if (apartReaches.length > 0 && !args.includes('--list')) {
  console.error(`A folder imports one ${MAP} keeps it apart from; take the service from the Context its root built:`);
  for (const r of apartReaches) console.error(`  ${r}`);
  process.exit(1);
}

const barrelReaches = findBarrelReaches(map, 'src');
if (barrelReaches.length > 0 && !args.includes('--list')) {
  console.error(`A barrel root file in ${MAP} reaches past its folder:`);
  for (const r of barrelReaches) console.error(`  ${r}`);
  process.exit(1);
}

const dbReach = findDbReaches(map, 'src');
if (dbReach.reaches.length + dbReach.stale.length > 0 && !args.includes('--update') && !args.includes('--list')) {
  const layer = map.dbReach.layer;
  for (const r of dbReach.reaches) console.error(`  ${r}`);
  for (const s of dbReach.stale) console.error(`  ${MAP} dbReach.allowed: ${s}`);
  console.error(
    `A file outside src/${layer} and src/${map.dbReach.through} reaches the ${layer} layer through a src/${map.dbReach.through} function, the door src/store/sqlite/index.ts or the store errors in src/store/port.ts.`,
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
