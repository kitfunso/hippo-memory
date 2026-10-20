import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-layers.mjs');
const MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const ROUTE_CALLS = [
  "import { requireGroup } from '../../../x.js';",
  "export const r = (s) => requireGroup(s, 'g');",
  '',
].join('\n');
const ROUTE_CLEAN = [
  '// not requireGroup',
  "import { graphRows } from '../../../api/graph.js';",
  'export const r = graphRows;',
  '',
].join('\n');
const ROUTE_MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high', surface: 'high' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const ROOT_CAP = { rootFiles: 2 };
const CLI_MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high', surface: 'high', store: 'low' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const CLI_BASE = { 'src/a.ts': '', 'src/b.ts': '', 'src/store/s.ts': 'export const s = 1;\nexport type S = 1;\n' };
type DbAllowed = Record<string, { names: string[]; why: string }>;
const dbMap = (allowed: DbAllowed) => ({
  order: ['low', 'db', 'store', 'high'],
  folders: { sub: 'high', db: 'db', store: 'store', api: 'high' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
  dbReach: { layer: 'db', through: 'store', allowed },
});
const DB_FILES = {
  'src/a.ts': '',
  'src/b.ts': '',
  'src/db/x.ts': 'export const open = 1;\nexport const scope = 2;\nexport type Handle = 3;\n',
  'src/store/keep.ts': '',
  'src/api/keep.ts': '',
};
const SCOPE_ONLY = { 'api/y.ts': { names: ['scope'], why: 'the request scope stays in db' } };
const SQLITE_MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high', api: 'high', surface: 'high', store: 'low' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const SQLITE_BASE = {
  'src/a.ts': '',
  'src/b.ts': '',
  'src/api/keep.ts': '',
  'src/surface/connectors/keep.ts': '',
  'src/surface/mcp/keep.ts': '',
  'src/store/sqlite/store.ts': 'export const storeFor = 1;\nexport type S = 1;\n',
  'src/store/sqlite/index.ts': "export { storeFor } from './store.js';\n",
  'src/store/sqlite/fixtures.ts': 'export const seed = 1;\n',
};
const PORT_BASE = {
  ...SQLITE_BASE,
  'src/store/rows.ts': 'export const rule = 1;\nexport type R = 1;\n',
  'src/store/port.ts': 'export type P = 1;\n',
  'src/store/port-groups.ts': 'export type G = 1;\n',
  'src/store/port/types.ts': 'export type T = 1;\n',
  'src/store/local/index.ts': 'export const isLocal = 1;\n',
};
const LOCAL_MAP = { ...SQLITE_MAP, folders: { ...SQLITE_MAP.folders, domain: 'high' } };
const LOCAL_BASE = { ...PORT_BASE, 'src/domain/keep.ts': '' };
const LOCAL_IMPORT = "import { isLocal } from '../store/local/index.js';\nexport const y = isLocal;\n";
const SQLITE_IMPORT = "export const y = 1;\nimport { storeFor } from '../store/sqlite/store.js';\n";
const DOOR_IMPORT = "export const y = 1;\nimport { storeFor } from '../store/sqlite/index.js';\n";
const FIXTURES_IMPORT = "import { seed } from '../store/sqlite/fixtures.js';\nexport const z = seed;\n";
const ENTRY_MAP = { ...SQLITE_MAP, folders: { ...SQLITE_MAP.folders, entry: 'high' } };
const SURFACE_SQLITE_IMPORT = "export const y = 1;\nimport { storeFor } from '../../store/sqlite/store.js';\n";
const DASHBOARD_MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high', api: 'high', surface: 'high', store: 'low' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const DASHBOARD_BASE = {
  'src/a.ts': '',
  'src/b.ts': '',
  'src/api/read.ts': 'export const read = 1;\n',
  'src/surface/cli/out.ts': 'export const cli = 1;\n',
  'src/store/rows.ts': 'export const rule = 1;\n',
  'src/store/port.ts': 'export type R = 1;\n',
};

type Row = {
  name: string;
  files: Record<string, string>;
  map?: object;
  baseline?: object;
  status: number;
  output: string[];
};

const rows: Row[] = [
  {
    name: 'a runtime import of a higher layer fails with file:line',
    files: { 'src/a.ts': "export const a = 1;\nimport { b } from './b.js';\n", 'src/b.ts': 'export const b = 1;\n' },
    status: 1,
    output: ['a.ts:2 -> b.ts (low -> high, runtime)'],
  },
  {
    name: 'a type-only upward import fails too and is listed as type',
    files: { 'src/a.ts': "import type { B } from './b.js';\nexport type A = B;\n", 'src/b.ts': 'export type B = 1;\n' },
    status: 1,
    output: ['a.ts:1 -> b.ts (low -> high, type)'],
  },
  {
    name: 'a dynamic upward import counts as runtime',
    files: {
      'src/a.ts': "export const load = () => import('./sub/x.js');\n",
      'src/b.ts': '',
      'src/sub/x.ts': 'export const x = 1;\n',
    },
    status: 1,
    output: ['a.ts:1 -> sub/x.ts (low -> high, runtime)'],
  },
  {
    name: 'a root file missing from layers.json fails by name',
    files: { 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' },
    status: 1,
    output: ['root file src/c.ts is not listed'],
  },
  {
    name: 'root files past the cap in the baseline fail',
    files: { 'src/a.ts': '', 'src/b.ts': '' },
    baseline: { rootFiles: 1 },
    status: 1,
    output: ['rootFiles: 1 -> 2'],
  },
  {
    name: 'a route that calls requireGroup fails with file:line',
    files: { 'src/a.ts': '', 'src/b.ts': '', 'src/surface/server/routes/r.ts': ROUTE_CALLS },
    map: ROUTE_MAP,
    status: 1,
    output: ['surface/server/routes/r.ts:1', 'surface/server/routes/r.ts:2'],
  },
  {
    name: 'a route that imports storeFor fails',
    files: {
      'src/a.ts': '',
      'src/b.ts': '',
      'src/surface/server/routes/r.ts': "import { storeFor } from '../../../x.js';\n",
    },
    map: ROUTE_MAP,
    status: 1,
    output: ['surface/server/routes/r.ts:1'],
  },
  {
    name: 'a route that goes through an api function passes, and a comment naming requireGroup is ignored',
    files: { 'src/a.ts': '', 'src/b.ts': '', 'src/surface/server/routes/r.ts': ROUTE_CLEAN },
    map: ROUTE_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'a CLI runtime import of the store fails with file:line',
    files: { ...CLI_BASE, 'src/surface/cli/v.ts': "export const v = 1;\nimport { s } from '../../store/s.js';\n" },
    map: CLI_MAP,
    status: 1,
    output: ['src/surface/cli/v.ts:2 imports src/store/s.ts at runtime'],
  },
  {
    name: 'a CLI type-only import of the store passes',
    files: { ...CLI_BASE, 'src/surface/cli/v.ts': "import type { S } from '../../store/s.js';\nexport type V = S;\n" },
    map: CLI_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'an api file that imports the db layer fails with file:line and the name',
    files: { ...DB_FILES, 'src/api/y.ts': "import { open } from '../db/x.js';\n" },
    map: dbMap({}),
    status: 1,
    output: ['api/y.ts:1 imports open from db/x.ts'],
  },
  {
    name: 'a type-only or namespace import of the db layer fails too',
    files: {
      ...DB_FILES,
      'src/api/y.ts': "import type { Handle } from '../db/x.js';\nimport * as db from '../db/x.js';\n",
    },
    map: dbMap({}),
    status: 1,
    output: ['api/y.ts:1 imports Handle from db/x.ts', 'api/y.ts:2 imports * from db/x.ts'],
  },
  {
    name: 'a file in any folder above the store, or a root file, that imports the db layer fails',
    files: {
      ...DB_FILES,
      'src/b.ts': "import { open } from './db/x.js';\nexport const b = open;\n",
      'src/sub/c.ts': "export const c = 1;\nimport { scope } from '../db/x.js';\n",
    },
    map: dbMap({}),
    status: 1,
    output: ['b.ts:1 imports open from db/x.ts', 'sub/c.ts:2 imports scope from db/x.ts'],
  },
  {
    name: 'a store file may import the db layer',
    files: { ...DB_FILES, 'src/store/s.ts': "import { open } from '../db/x.js';\nexport const s = open;\n" },
    map: dbMap({}),
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'an allowed name passes and an unlisted one beside it fails',
    files: { ...DB_FILES, 'src/api/y.ts': "import { scope, open } from '../db/x.js';\n" },
    map: dbMap(SCOPE_ONLY),
    status: 1,
    output: ['api/y.ts:1 imports open from db/x.ts'],
  },
  {
    name: 'an import the allow list names passes',
    files: { ...DB_FILES, 'src/api/y.ts': "import { scope } from '../db/x.js';\n" },
    map: dbMap(SCOPE_ONLY),
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'an allowlisted CLI store import with a reason passes',
    files: {
      ...CLI_BASE,
      'src/surface/cli/v.ts': "import { s } from '../../store/s.js';\n",
      '.cli-store-allowlist.json': JSON.stringify([
        { file: 'surface/cli/v.ts', target: 'store/s.ts', why: 'a constant' },
      ]),
    },
    map: CLI_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'an allowlist entry with no reason or no matching import fails',
    files: {
      ...CLI_BASE,
      'src/surface/cli/v.ts': "import { s } from '../../store/s.js';\n",
      '.cli-store-allowlist.json': JSON.stringify([
        { file: 'surface/cli/v.ts', target: 'store/s.ts', why: ' ' },
        { file: 'surface/cli/w.ts', target: 'store/s.ts', why: 'gone' },
      ]),
    },
    map: CLI_MAP,
    status: 1,
    output: [
      'src/surface/cli/v.ts -> src/store/s.ts gives no reason',
      'src/surface/cli/w.ts -> src/store/s.ts matches no import',
    ],
  },
  {
    name: 'an allowed name the file no longer imports fails as stale',
    files: { ...DB_FILES, 'src/api/y.ts': 'export const y = 1;\n' },
    map: dbMap(SCOPE_ONLY),
    status: 1,
    output: ['dbReach.allowed: api/y.ts no longer imports scope'],
  },
  {
    name: 'an allowed entry with no why fails',
    files: { ...DB_FILES, 'src/api/y.ts': "import { scope } from '../db/x.js';\n" },
    map: dbMap({ 'api/y.ts': { names: ['scope'], why: ' ' } }),
    status: 1,
    output: ['dbReach.allowed: api/y.ts gives no why'],
  },
  {
    name: 'a new api file that imports the SQLite adapter at runtime fails with file:line',
    files: { ...SQLITE_BASE, 'src/api/y.ts': SQLITE_IMPORT },
    map: SQLITE_MAP,
    status: 1,
    output: ['src/api/y.ts:2 imports src/store/sqlite/store.ts; take the store from a parameter or the Context'],
  },
  {
    name: 'a file in any other folder that imports the adapter fails, type-only, re-export and import() too',
    files: {
      ...SQLITE_BASE,
      'src/sub/t.ts': "import type { S } from '../store/sqlite/store.js';\nexport type T = S;\n",
      'src/sub/r.ts': "export { storeFor } from '../store/sqlite/store.js';\n",
      'src/sub/d.ts': "export const load = () => import('../store/sqlite/store.js');\n",
    },
    map: SQLITE_MAP,
    status: 1,
    output: [
      'src/sub/t.ts:1 imports src/store/sqlite/store.ts',
      'src/sub/r.ts:1 imports src/store/sqlite/store.ts',
      'src/sub/d.ts:1 imports src/store/sqlite/store.ts',
    ],
  },
  {
    name: 'a composition root may import the adapter through its door, and a store file is not counted',
    files: {
      ...SQLITE_BASE,
      'src/entry/testing.ts': DOOR_IMPORT,
      'src/store/port.ts': "import type { S } from './sqlite/store.js';\nexport type P = S;\n",
    },
    map: ENTRY_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'a composition root that imports a module behind the door fails with file:line, type-only too',
    files: {
      ...SQLITE_BASE,
      'src/entry/importers.ts': SQLITE_IMPORT,
      'src/entry/testing.ts': "import type { S } from '../store/sqlite/store.js';\nexport type T = S;\n",
    },
    map: ENTRY_MAP,
    status: 1,
    output: [
      "src/entry/importers.ts:2 imports src/store/sqlite/store.ts past the adapter's door; import src/store/sqlite/index.ts",
      'src/entry/testing.ts:1 imports src/store/sqlite/store.ts past the',
    ],
  },
  {
    name: 'the ./testing root opens the fixtures door, and any other root that does fails',
    files: {
      ...SQLITE_BASE,
      'src/entry/testing.ts': FIXTURES_IMPORT,
      'src/entry/importers.ts': FIXTURES_IMPORT,
    },
    map: ENTRY_MAP,
    status: 1,
    output: ["src/entry/importers.ts:1 imports src/store/sqlite/fixtures.ts past the adapter's door"],
  },
  {
    name: 'the ./testing root may import both doors',
    files: { ...SQLITE_BASE, 'src/entry/testing.ts': `${DOOR_IMPORT}${FIXTURES_IMPORT}` },
    map: ENTRY_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'a root that no longer imports the adapter fails until its entry goes',
    files: { ...SQLITE_BASE, 'src/entry/testing.ts': 'export const t = 1;\n' },
    map: ENTRY_MAP,
    status: 1,
    output: ['root: src/entry/testing.ts no longer imports src/store/sqlite/'],
  },
  {
    name: 'naming sqliteSyncStore outside the adapter and the roots fails',
    files: { ...SQLITE_BASE, 'src/sub/s.ts': 'export const pick = (sqliteSyncStore: number) => sqliteSyncStore;\n' },
    map: SQLITE_MAP,
    status: 1,
    output: ['src/sub/s.ts:1 names sqliteSyncStore'],
  },
  {
    name: 'a connectors or mcp file that imports the SQLite adapter fails the same way',
    files: {
      ...SQLITE_BASE,
      'src/surface/connectors/c.ts': SURFACE_SQLITE_IMPORT,
      'src/surface/mcp/m.ts': SURFACE_SQLITE_IMPORT,
    },
    map: SQLITE_MAP,
    status: 1,
    output: [
      'src/surface/connectors/c.ts:2 imports src/store/sqlite/store.ts',
      'src/surface/mcp/m.ts:2 imports src/store/sqlite/store.ts',
    ],
  },
  {
    name: 'an api type-only import of the SQLite adapter fails on the port rule',
    files: {
      ...SQLITE_BASE,
      'src/api/y.ts': "import type { S } from '../store/sqlite/store.js';\nexport type Y = S;\n",
    },
    map: SQLITE_MAP,
    status: 1,
    output: ['src/api/y.ts:1 imports src/store/sqlite/store.ts'],
  },
  {
    name: 'an api import of a store module outside the port fails, runtime or type-only',
    files: {
      ...PORT_BASE,
      'src/api/y.ts': "import { rule } from '../store/rows.js';\nexport const y = rule;\n",
      'src/api/z.ts': "import type { R } from '../store/rows.js';\nexport type Z = R;\n",
    },
    map: SQLITE_MAP,
    status: 1,
    output: ['src/api/y.ts:1 imports src/store/rows.ts', 'src/api/z.ts:1 imports src/store/rows.ts'],
  },
  {
    name: 'an api import of port.ts, port-groups.ts or port/ passes',
    files: {
      ...PORT_BASE,
      'src/api/y.ts': [
        "import type { P } from '../store/port.js';",
        "import type { G } from '../store/port-groups.js';",
        "import type { T } from '../store/port/types.js';",
        'export type Y = [P, G, T];',
        '',
      ].join('\n'),
    },
    map: SQLITE_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'an api or domain import of store/local fails, runtime or type-only',
    files: {
      ...LOCAL_BASE,
      'src/api/y.ts': "import type { isLocal } from '../store/local/index.js';\nexport type Y = typeof isLocal;\n",
      'src/domain/d.ts': "export const d = 1;\nimport { isLocal } from '../store/local/index.js';\n",
    },
    map: LOCAL_MAP,
    status: 1,
    output: ['src/api/y.ts:1 imports src/store/local/index.ts', 'src/domain/d.ts:2 imports src/store/local/index.ts'],
  },
  {
    name: 'a store/local import fails even when an old .store-local-pending.json lists it',
    files: {
      ...LOCAL_BASE,
      'src/api/y.ts': LOCAL_IMPORT,
      '.store-local-pending.json': JSON.stringify([{ file: 'api/y.ts', why: 'the next PR moves it' }]),
    },
    map: LOCAL_MAP,
    status: 1,
    output: ['src/api/y.ts:1 imports src/store/local/index.ts'],
  },
  {
    name: 'isLocalStore in the api or domain fails, and so does hippoRoot in the api',
    files: {
      ...LOCAL_BASE,
      'src/api/y.ts': 'export const y = 1;\nexport const root = (ctx) => ctx.hippoRoot;\n',
      'src/domain/d.ts': 'export const isLocalStore = 1;\n',
    },
    map: LOCAL_MAP,
    status: 1,
    output: ['src/api/y.ts:2 names hippoRoot', 'src/domain/d.ts:1 names isLocalStore'],
  },
  {
    name: 'hippoRoot in an api comment or in the domain passes',
    files: {
      ...LOCAL_BASE,
      'src/api/y.ts': '// the hippoRoot a surface keeps\nexport const y = 1;\n',
      'src/domain/d.ts': 'export const root = (o) => o.hippoRoot;\n',
    },
    map: LOCAL_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
  {
    name: 'a dashboard import of the store or the CLI fails, runtime or type-only',
    files: {
      ...DASHBOARD_BASE,
      'src/surface/dashboard/a.ts': "import { rule } from '../../store/rows.js';\nexport const a = rule;\n",
      'src/surface/dashboard/b.ts': "import type { R } from '../../store/port.js';\nexport type B = R;\n",
      'src/surface/dashboard/c.ts': "export const c = 1;\nimport { cli } from '../cli/out.js';\n",
    },
    map: DASHBOARD_MAP,
    status: 1,
    output: [
      'src/surface/dashboard/a.ts:1 imports src/store/rows.ts',
      'src/surface/dashboard/b.ts:1 imports src/store/port.ts',
      'src/surface/dashboard/c.ts:2 imports src/surface/cli/out.ts',
    ],
  },
  {
    name: 'a dashboard import of src/api passes',
    files: {
      ...DASHBOARD_BASE,
      'src/surface/dashboard/a.ts': "import { read } from '../../api/read.js';\nexport const a = read;\n",
    },
    map: DASHBOARD_MAP,
    status: 0,
    output: ['Layer order OK'],
  },
];

describe('check-layers.mjs', () => {
  it.each(rows)('$name', ({ files, map, baseline, status, output }) => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-layers-'));
    try {
      const all = {
        'layers.json': JSON.stringify(map ?? MAP),
        '.layers-baseline.json': JSON.stringify(baseline ?? ROOT_CAP),
        'src/sub/keep.ts': '',
        ...files,
      };
      for (const [p, text] of Object.entries(all)) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), text);
      }
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
      expect(r.status).toBe(status);
      for (const line of output) expect(r.stdout + r.stderr).toContain(line);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
