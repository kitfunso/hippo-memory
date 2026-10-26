// Import rules for src/, built from layers.json so the map and the rules cannot drift.
// Run: npm run check:deps. Name rules (requireGroup in routes, SQLite words) live in .oxlintrc.json;
// runtime cycles between features are .dependency-cruiser-cycles.cjs.
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

module.exports = {
  forbidden: [...layerOrder, ...apart, ...barrels, ...adapterRules, ...storeReach],
  required: adapterRequired,
  options: {
    includeOnly: '^src/',
    exclude: { path: '\\.d\\.ts$' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
