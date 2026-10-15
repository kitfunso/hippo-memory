import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-layers.mjs');
const MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const ROUTE_CALLS = ["import { requireGroup } from '../../x.js';", "export const r = (s) => requireGroup(s, 'g');", ''].join('\n');
const ROUTE_CLEAN = ['// not requireGroup', "import { graphRows } from '../../api/graph.js';", 'export const r = graphRows;', ''].join('\n');
const ROUTE_MAP = { order: ['low', 'high'], folders: { sub: 'high', server: 'high' }, rootFiles: { 'a.ts': 'low', 'b.ts': 'high' } };
const NO_EDGES = { runtime: 0, typeOnly: 0, rootFiles: 2, edges: [] };
const CLI_MAP = { order: ['low', 'high'], folders: { sub: 'high', cli: 'high', store: 'low' }, rootFiles: { 'a.ts': 'low', 'b.ts': 'high' } };
const CLI_BASE = { 'src/a.ts': '', 'src/b.ts': '', 'src/store/s.ts': 'export const s = 1;\nexport type S = 1;\n' };
type DbAllowed = Record<string, { names: string[]; why: string }>;
const dbMap = (allowed: DbAllowed) => ({
  order: ['low', 'db', 'high'],
  folders: { sub: 'high', db: 'db', api: 'high' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
  dbReach: { layer: 'db', from: ['api'], allowed },
});
const DB_FILES = { 'src/a.ts': '', 'src/b.ts': '', 'src/db/x.ts': 'export const open = 1;\nexport const scope = 2;\nexport type Handle = 3;\n' };
const SCOPE_ONLY = { 'api/y.ts': { names: ['scope'], why: 'the request scope stays in db' } };
const SQLITE_MAP = {
  order: ['low', 'high'],
  folders: { sub: 'high', api: 'high', connectors: 'high', mcp: 'high', store: 'low' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
};
const SQLITE_BASE = {
  'src/a.ts': '',
  'src/b.ts': '',
  'src/api/keep.ts': '',
  'src/connectors/keep.ts': '',
  'src/mcp/keep.ts': '',
  'src/store/sqlite/local.ts': 'export const changeScopeGrant = 1;\n',
  'src/store/sqlite/store.ts': 'export const storeFor = 1;\nexport type S = 1;\n',
};
const LOCAL_IMPORT = "export const y = 1;\nimport { changeScopeGrant } from '../store/sqlite/local.js';\n";
const SQLITE_IMPORT ="export const y = 1;\nimport { storeFor } from '../store/sqlite/store.js';\n";

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
    name: 'import type upward lands in typeOnly and is listed as type',
    files: { 'src/a.ts': "import type { B } from './b.js';\nexport type A = B;\n", 'src/b.ts': 'export type B = 1;\n' },
    baseline: { runtime: 0, typeOnly: 1, rootFiles: 2, edges: [{ from: 'a.ts', to: 'b.ts', kind: 'typeOnly' }] },
    status: 0,
    output: ['0 runtime and 1 type-only'],
  },
  {
    name: 'a dynamic upward import counts as runtime',
    files: { 'src/a.ts': "export const load = () => import('./sub/x.js');\n", 'src/b.ts': '', 'src/sub/x.ts': 'export const x = 1;\n' },
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
    name: 'one baseline edge fixed plus one new edge still fails',
    files: { 'src/a.ts': "import './sub/y.js';\n", 'src/b.ts': '', 'src/sub/x.ts': '', 'src/sub/y.ts': '' },
    baseline: { runtime: 1, typeOnly: 0, rootFiles: 2, edges: [{ from: 'a.ts', to: 'sub/x.ts', kind: 'runtime' }] },
    status: 1,
    output: ['a.ts:1 -> sub/y.ts'],
  },
  {
    name: 'a route that calls requireGroup fails with file:line',
    files: { 'src/a.ts': '', 'src/b.ts': '', 'src/server/routes/r.ts': ROUTE_CALLS },
    map: ROUTE_MAP,
    status: 1,
    output: ['server/routes/r.ts:1', 'server/routes/r.ts:2'],
  },
  {
    name: 'a route that imports storeFor fails',
    files: { 'src/a.ts': '', 'src/b.ts': '', 'src/server/routes/r.ts': "import { storeFor } from '../../x.js';\n" },
    map: ROUTE_MAP,
    status: 1,
    output: ['server/routes/r.ts:1'],
  },
  {
    name: 'a route that goes through an api function passes, and a comment naming requireGroup is ignored',
    files: { 'src/a.ts': '', 'src/b.ts': '', 'src/server/routes/r.ts': ROUTE_CLEAN },
    map: ROUTE_MAP,
    status: 0,
    output: ['Layer ratchet OK'],
  },
  {
    name: 'a CLI runtime import of the store fails with file:line',
    files: { ...CLI_BASE, 'src/cli/v.ts': "export const v = 1;\nimport { s } from '../store/s.js';\n" },
    map: CLI_MAP,
    status: 1,
    output: ['src/cli/v.ts:2 imports src/store/s.ts at runtime'],
  },
  {
    name: 'a CLI type-only import of the store passes',
    files: { ...CLI_BASE, 'src/cli/v.ts': "import type { S } from '../store/s.js';\nexport type V = S;\n" },
    map: CLI_MAP,
    status: 0,
    output: ['Layer ratchet OK'],
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
    files: { ...DB_FILES, 'src/api/y.ts': "import type { Handle } from '../db/x.js';\nimport * as db from '../db/x.js';\n" },
    map: dbMap({}),
    status: 1,
    output: ['api/y.ts:1 imports Handle from db/x.ts', 'api/y.ts:2 imports * from db/x.ts'],
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
    output: ['Layer ratchet OK'],
  },
  {
    name: 'an allowlisted CLI store import with a reason passes',
    files: { ...CLI_BASE, 'src/cli/v.ts': "import { s } from '../store/s.js';\n", '.cli-store-allowlist.json': JSON.stringify([{ file: 'cli/v.ts', target: 'store/s.ts', why: 'a constant' }]) },
    map: CLI_MAP,
    status: 0,
    output: ['Layer ratchet OK'],
  },
  {
    name: 'an allowlist entry with no reason or no matching import fails',
    files: {
      ...CLI_BASE,
      'src/cli/v.ts': "import { s } from '../store/s.js';\n",
      '.cli-store-allowlist.json': JSON.stringify([{ file: 'cli/v.ts', target: 'store/s.ts', why: ' ' }, { file: 'cli/w.ts', target: 'store/s.ts', why: 'gone' }]),
    },
    map: CLI_MAP,
    status: 1,
    output: ['src/cli/v.ts -> src/store/s.ts gives no reason', 'src/cli/w.ts -> src/store/s.ts matches no import'],
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
    output: ['src/api/y.ts:2 imports src/store/sqlite/store.ts at runtime'],
  },
  {
    name: 'a connectors or mcp file that imports the SQLite adapter fails the same way',
    files: { ...SQLITE_BASE, 'src/connectors/c.ts': SQLITE_IMPORT, 'src/mcp/m.ts': SQLITE_IMPORT },
    map: SQLITE_MAP,
    status: 1,
    output: ['src/connectors/c.ts:2 imports src/store/sqlite/store.ts', 'src/mcp/m.ts:2 imports src/store/sqlite/store.ts'],
  },
  {
    name: 'an api type-only import of the SQLite adapter passes',
    files: { ...SQLITE_BASE, 'src/api/y.ts': "import type { S } from '../store/sqlite/store.js';\nexport type Y = S;\n" },
    map: SQLITE_MAP,
    status: 0,
    output: ['Layer ratchet OK'],
  },
  {
    name: 'a pinned file may import the SQLite adapter',
    files: { ...SQLITE_BASE, 'src/api/auth.ts': LOCAL_IMPORT },
    map: SQLITE_MAP,
    status: 0,
    output: ['Layer ratchet OK'],
  },
  {
    name: 'a pinned file that no longer imports the SQLite adapter fails as stale',
    files: { ...SQLITE_BASE, 'src/api/auth.ts': 'export const s = 1;\n' },
    map: SQLITE_MAP,
    status: 1,
    output: ['pinned: src/api/auth.ts no longer imports src/store/sqlite/local.ts'],
  },
];

describe('check-layers.mjs', () => {
  it.each(rows)('$name', ({ files, map, baseline, status, output }) => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-layers-'));
    try {
      const all = {
        'layers.json': JSON.stringify(map ?? MAP),
        '.layers-baseline.json': JSON.stringify(baseline ?? NO_EDGES),
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
