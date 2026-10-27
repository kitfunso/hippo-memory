// Import rules for src/, built from layers.json so the map and the rules cannot drift.
// Run: npm run check:deps. Name and syntax rules (requireGroup in routes, SQLite words, process.env)
// live in .oxlintrc.json; runtime cycles between features are .dependency-cruiser-cycles.cjs.
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
  return problems;
}

const problems = mapProblems();
if (problems.length > 0) {
  throw new Error(`layers.json does not match src/:\n  ${problems.join('\n  ')}\nList the folder or file under its layer, or remove the stale entry.`);
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

const adapterRules = [
  {
    name: 'adapter-entrances',
    comment: `only src/${adapter.root} and the test kit import src/${adapter.folder}; others take the store from the Context`,
    severity: 'error',
    from: { pathNot: [adapterPath, srcPaths([], entrances)] },
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
    from: { path: '^src/', pathNot: [layerPaths(dbReach.layer), layerPaths(dbReach.through)] },
    to: { path: layerPaths(dbReach.layer) },
  },
  {
    name: 'api-store-port',
    comment: 'the api reads the store through the port in src/base/ports and takes shared rules from src/base',
    severity: 'error',
    from: { path: '^src/api/' },
    to: { path: '^src/store/' },
  },
  {
    name: 'cli-store-runtime',
    comment: 'the CLI calls a src/api function; a type import from the store is fine',
    severity: 'error',
    from: { path: '^src/(cli\\.ts$|surface/cli/)' },
    to: { path: '^src/(store|db)/', dependencyTypesNot: ['type-only', 'type-import'] },
  },
  {
    name: 'dashboard-through-api',
    comment: 'the dashboard reads and writes through src/api, never the store, the db or the CLI',
    severity: 'error',
    from: { path: '^src/surface/dashboard/' },
    to: { path: '^src/(store/|db/|surface/cli/|cli\\.ts$)' },
  },
];

const IO_MODULES = '^(fs|fs/promises|os|child_process)$';
const SQLITE_MODULE = '^node:sqlite$';
const notType = ['type-only', 'type-import'];
// The composition roots and adapters, which read the environment once and pass settings down.
const ENV_READERS = [
  '^src/cli\\.ts$',
  '^src/surface/(cli|server|mcp|hooks-install)/',
  '^src/surface/connectors/[^/]+/webhook\\.ts$',
  '^src/infra/',
  '^src/base/util/(env|log)\\.ts$',
  '^src/host/(spawn-argv|agent-homes)\\.ts$',
];
const STRAY_STORE = { path: '^src/store/', pathNot: '^src/store/(sqlite|rules)/' };
const strayStore = {
  comment: 'src/store holds the SQLite adapter and the rules it shares; a rule with no SQL goes in src/base',
  severity: 'error',
};

const reachRules = [
  {
    name: 'no-io-below-host',
    comment: 'src/base, src/domain and src/api read no disk or process; src/host does, and its caller passes the answer',
    severity: 'error',
    from: { path: '^src/(base|domain|api)/' },
    to: { path: IO_MODULES },
  },
  {
    name: 'host-types-only',
    comment: 'src/domain and src/api take what src/host reads from their caller, and may name its types',
    severity: 'error',
    from: { path: '^src/(domain|api)/' },
    to: { path: '^src/host/', dependencyTypesNot: notType },
  },
  {
    name: 'sqlite-in-data-layer',
    comment: 'only src/db and src/store hold a hippo.db handle, and src/host/file-lock.ts a data-free lock database; code above them reaches hippo.db through the port',
    severity: 'error',
    from: { pathNot: ['^src/(db|store)/', '^src/host/file-lock\\.ts$'] },
    to: { path: SQLITE_MODULE },
  },
  {
    name: 'store-rules-pure',
    comment: 'src/store/rules runs no SQL and opens nothing: it imports src/base and itself only',
    severity: 'error',
    from: { path: '^src/store/rules/' },
    to: { pathNot: '^src/(base|store/rules)/' },
  },
  { name: 'store-folders', ...strayStore, from: STRAY_STORE, to: {} },
  { name: 'store-folders-used', ...strayStore, from: {}, to: STRAY_STORE },
  { name: 'store-folders-orphan', ...strayStore, from: { ...STRAY_STORE, orphan: true }, to: {} },
  {
    name: 'config-file-in-surface',
    comment: 'only src/host and the surface reach config.json; api code reads ctx.config, others take it from their caller',
    severity: 'error',
    from: { path: '^src/', pathNot: [layerPaths('surface'), layerPaths('host')] },
    to: { path: '^src/host/config-file\\.ts$', dependencyTypesNot: notType },
  },
  {
    name: 'env-in-roots',
    comment: 'src/base/util/env.ts is read by the composition roots and adapters, which pass settings down',
    severity: 'error',
    from: { path: '^src/', pathNot: ENV_READERS },
    to: { path: '^src/base/util/env\\.ts$' },
  },
  {
    name: 'recall-verbs-book-nothing',
    comment: 'hippo recall and hippo explain book tokens and ledger turns through retrieveWithCliCore(), never by hand',
    severity: 'error',
    from: { path: '^src/surface/cli/(recall|explain)\\.ts$' },
    to: { path: '^src/api/(tokens|ledger-db)\\.ts$' },
  },
];

module.exports = {
  forbidden: [...layerOrder, ...apart, ...barrels, ...adapterRules, ...storeReach, ...reachRules],
  required: adapterRequired,
  options: {
    // The node modules a rule names are kept, so a rule can bar a src file from them.
    includeOnly: ['^src/', IO_MODULES, SQLITE_MODULE],
    exclude: { path: '\\.d\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
