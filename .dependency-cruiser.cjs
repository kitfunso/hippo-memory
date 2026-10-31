// Import rules for src/, built from layers.json so the map and the rules cannot drift.
// Run: npm run check:deps. Name and syntax rules (SQLite words, process.env)
// live in oxlint.config.ts; runtime cycles between features are .dependency-cruiser-cycles.cjs.
'use strict';
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const layers = require('./layers.json');

const SRC = join(__dirname, 'src');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path regex for src files under `folders` or equal to `roots`. */
function srcPaths(folders, roots = []) {
  const parts = [...folders.map((f) => `${escape(f)}/`), ...roots.map((r) => `${escape(r)}$`)];
  return `^src/(${parts.join('|')})`;
}

const keysOf = (record, layer) => Object.keys(record).filter((key) => record[key] === layer);
const layerPaths = (layer) => srcPaths(keysOf(layers.folders, layer), keysOf(layers.rootFiles, layer));
// Every src file the map lists, for a rule that starts from any of them.
const ANY_SRC = srcPaths(Object.keys(layers.folders), Object.keys(layers.rootFiles));

/** The regex for one path group entry: `@layer`, a folder ending in `/`, or a file; `*` stands for one name. */
function entryPaths(entry) {
  if (entry.startsWith('@')) return layerPaths(entry.slice(1));
  return `^src/${escape(entry).replaceAll('\\*', '[^/]*')}${entry.endsWith('/') ? '' : '$'}`;
}

/** The regexes of the path group `name` in layers.json, which holds every path a rule below names. */
function group(name) {
  if (!(name in layers.paths)) throw new Error(`layers.json has no path group "${name}"`);
  return layers.paths[name].map(entryPaths);
}

/** Every src folder or root file layers.json lacks, every entry that no longer exists, and every named file gone. */
function mapProblems() {
  const entries = readdirSync(SRC, { withFileTypes: true });
  const actual = {
    folder: entries.filter((e) => e.isDirectory()).map((e) => e.name),
    'root file': entries.filter((e) => e.isFile() && /(?<!\.d)\.ts$/.test(e.name)).map((e) => e.name),
  };
  const listed = { folder: layers.folders, 'root file': layers.rootFiles };
  const problems = [];
  for (const kind of Object.keys(listed)) {
    for (const name of actual[kind]) {
      if (!(name in listed[kind])) problems.push(`${kind} src/${name} is not listed`);
    }
    for (const [name, layer] of Object.entries(listed[kind])) {
      if (!actual[kind].includes(name)) problems.push(`${kind} src/${name} is listed but does not exist`);
      if (!layers.order.includes(layer)) problems.push(`${kind} src/${name} names unknown layer "${layer}"`);
    }
  }
  const { adapter } = layers;
  const named = [adapter.root, adapter.testKit.file, adapter.testKit.door, ...adapter.doors];
  for (const file of [...named, ...Object.keys(layers.barrels)]) {
    if (!existsSync(join(SRC, file))) problems.push(`src/${file} is named but does not exist`);
  }
  const files = readdirSync(SRC, { recursive: true }).map((p) => `src/${String(p).replaceAll('\\', '/')}`);
  for (const [name, entries] of Object.entries(layers.paths)) {
    for (const entry of entries) {
      const known = entry.startsWith('@')
        ? layers.order.includes(entry.slice(1))
        : files.some((f) => new RegExp(entryPaths(entry)).test(f));
      if (!known) {
        problems.push(`path group ${name} entry ${entry} matches no src file`);
      }
    }
  }
  return problems;
}

const problems = mapProblems();
if (problems.length > 0) {
  throw new Error(
    `layers.json does not match src/:\n  ${problems.join('\n  ')}\nList the folder or file under its layer, or remove the stale entry.`,
  );
}

/** One rule per layer: its files import nothing from a higher layer, type-only imports included. */
const layerOrder = layers.order.slice(0, -1).map((layer, i) => ({
  name: `layer-${layer}`,
  comment: `${layer} imports only from its own layer or a lower one (order: ${layers.order.join(' < ')})`,
  severity: 'error',
  from: { path: layerPaths(layer) },
  to: { path: layers.order.slice(i + 1).map(layerPaths) },
}));

const apart = Object.entries(layers.apart).map(([folder, barred]) => ({
  name: `apart-${folder}`,
  comment: `src/${folder} takes ${barred.join(', ')} from the Context its root built, never by import`,
  severity: 'error',
  from: { path: srcPaths([folder]) },
  to: { path: srcPaths(barred) },
}));

const barrels = Object.entries(layers.barrels).map(([file, folder]) => ({
  name: `barrel-${file}`,
  comment: `src/${file} imports and re-exports only from src/${folder}`,
  severity: 'error',
  from: { path: srcPaths([], [file]) },
  to: { pathNot: srcPaths([folder]) },
}));

const { adapter, dbReach } = layers;
const adapterPath = srcPaths([adapter.folder]);
const entrances = [adapter.root, adapter.testKit.file];
const outsideAdapter = [adapterPath, srcPaths([], entrances)];

const adapterRules = [
  {
    name: 'adapter-entrances',
    comment: `only src/${adapter.root} and the test kit import src/${adapter.folder}; others take the store from the Context`,
    severity: 'error',
    from: { pathNot: outsideAdapter },
    to: { path: adapterPath },
  },
  {
    name: 'adapter-root-doors',
    comment: `src/${adapter.root} imports the adapter only through its doors`,
    severity: 'error',
    from: { path: srcPaths([], [adapter.root]) },
    to: { path: adapterPath, pathNot: srcPaths([], adapter.doors) },
  },
  {
    name: 'adapter-kit-door',
    comment: `src/${adapter.testKit.file} imports the adapter only through src/${adapter.testKit.door}`,
    severity: 'error',
    from: { path: srcPaths([], [adapter.testKit.file]) },
    to: { path: adapterPath, pathNot: srcPaths([], [adapter.testKit.door]) },
  },
];

/** A root or kit that stops importing the adapter means layers.json names the wrong file. */
const adapterRequired = entrances.map((file) => ({
  name: `adapter-used-by-${file.replace(/\W+/g, '-')}`,
  comment: `layers.json names src/${file} as an adapter entrance, so it must import src/${adapter.folder}`,
  module: { path: srcPaths([], [file]) },
  to: { path: adapterPath },
}));

const storeReach = [
  {
    name: 'db-through-store',
    comment: `files outside src/${dbReach.layer} and src/${dbReach.through} reach the db through a store function or the adapter door`,
    severity: 'error',
    from: { path: ANY_SRC, pathNot: [layerPaths(dbReach.layer), layerPaths(dbReach.through)] },
    to: { path: layerPaths(dbReach.layer) },
  },
  {
    name: 'db-grant-mint',
    comment: 'only the SQLite adapter mints a hippo.db grant; other code imports the DbGrant type',
    severity: 'error',
    from: { path: ANY_SRC, pathNot: group('grantMinter') },
    to: { path: group('grant'), dependencyTypesNot: ['type-only', 'type-import'] },
  },
  {
    name: 'api-store-port',
    comment: 'the api reads the store through the port in src/base/ports and takes shared rules from src/base',
    severity: 'error',
    from: { path: layerPaths('api') },
    to: { path: layerPaths(dbReach.through) },
  },
  {
    name: 'core-port-no-sqlite',
    comment: `a core file reaches src/${adapter.folder} and the local tier's port through no module, type-only imports included; its local work lives in src/api/hippo-db`,
    severity: 'error',
    from: { path: group('core') },
    to: { path: [adapterPath, ...group('localTier')], reachable: true },
  },
  {
    name: 'surface-through-api',
    comment: `a surface calls src/api, never the store or the db; only ${entrances.map((f) => `src/${f}`).join(' and ')} open one`,
    severity: 'error',
    from: { path: layerPaths('surface'), pathNot: srcPaths([], entrances) },
    to: { path: [layerPaths(dbReach.layer), layerPaths(dbReach.through)] },
  },
  {
    name: 'dashboard-not-cli',
    comment: 'the dashboard reads and writes through src/api, never through the CLI',
    severity: 'error',
    from: { path: group('dashboard') },
    to: { path: group('cli') },
  },
];

const IO_MODULES = '^(fs|fs/promises|os|child_process)$';
const SQLITE_MODULE = '^node:sqlite$';
const notType = ['type-only', 'type-import'];
const STRAY_STORE = { path: layerPaths(dbReach.through), pathNot: [adapterPath, ...group('storeRules')] };
const strayStore = {
  comment: 'src/store holds the SQLite adapter and the rules it shares; a rule with no SQL goes in src/base',
  severity: 'error',
};

// One rule per depth, for the file's own folder, its parent and its grandparent: $1 is that folder.
const ownBarrels = ['', '[^/]+/', '[^/]+/[^/]+/'].map((below, up) => ({
  name: `no-own-barrel-${up}`,
  comment:
    'a file imports the module that defines a name, never the index.ts of its folder or one above, which re-exports the file and loops back',
  severity: 'error',
  from: { path: `^(src/.+/)${below}[^/]+$`, pathNot: up === 0 ? '/index\\.ts$' : '^$' },
  to: { path: '^$1index\\.ts$' },
}));

const reachRules = [
  {
    name: 'no-io-below-host',
    comment:
      'src/base, src/domain and src/api read no disk or process; src/host does, and its caller passes the answer',
    severity: 'error',
    from: { path: group('ioFree') },
    to: { path: IO_MODULES },
  },
  {
    name: 'host-types-only',
    comment: 'src/domain and src/api take what src/host reads from their caller, and may name its types',
    severity: 'error',
    from: { path: group('hostTypesOnly') },
    to: { path: layerPaths('host'), dependencyTypesNot: notType },
  },
  {
    name: 'sqlite-in-data-layer',
    comment:
      'only src/db/sqlite.ts loads node:sqlite, and src/host/file-lock.ts for a data-free lock database; every other SQLite connection is made through src/db/sqlite.ts',
    severity: 'error',
    from: { pathNot: group('sqliteLoaders') },
    to: { path: SQLITE_MODULE },
  },
  {
    name: 'db-dynamic-import',
    comment: 'src/db is imported statically, so the DbGrant lint ban sees every hippo.db opener a file names',
    severity: 'error',
    from: { path: ANY_SRC },
    to: { path: layerPaths(dbReach.layer), dependencyTypes: ['dynamic-import'] },
  },
  {
    name: 'store-rules-pure',
    comment: 'src/store/rules runs no SQL and opens nothing: it imports src/base and itself only',
    severity: 'error',
    from: { path: group('storeRules') },
    to: { pathNot: [layerPaths('base'), ...group('storeRules')] },
  },
  ...ownBarrels,
  { name: 'store-folders', ...strayStore, from: STRAY_STORE, to: {} },
  { name: 'store-folders-used', ...strayStore, from: {}, to: STRAY_STORE },
  { name: 'store-folders-orphan', ...strayStore, from: { ...STRAY_STORE, orphan: true }, to: {} },
  {
    name: 'config-file-in-surface',
    comment:
      'only src/host and the surface reach config.json; api code reads ctx.config, others take it from their caller',
    severity: 'error',
    from: { path: ANY_SRC, pathNot: [layerPaths('surface'), layerPaths('host')] },
    to: { path: group('configFile'), dependencyTypesNot: notType },
  },
  {
    name: 'env-in-roots',
    comment: 'src/base/util/env.ts is read by the composition roots and adapters, which pass settings down',
    severity: 'error',
    from: { path: ANY_SRC, pathNot: group('envReaders') },
    to: { path: group('env') },
  },
  {
    name: 'recall-verbs-book-nothing',
    comment: 'hippo recall and hippo explain book tokens and ledger turns through retrieveWithCliCore(), never by hand',
    severity: 'error',
    from: { path: group('recallVerbs') },
    to: { path: group('bookkeeping') },
  },
];

module.exports = {
  forbidden: [...layerOrder, ...apart, ...barrels, ...adapterRules, ...storeReach, ...reachRules],
  required: adapterRequired,
  options: {
    // The node modules a rule names are kept, so a rule can bar a src file from them.
    includeOnly: [ANY_SRC, IO_MODULES, SQLITE_MODULE],
    exclude: { path: '\\.d\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
