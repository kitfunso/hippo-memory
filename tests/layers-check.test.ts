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
type DbAllowed = Record<string, { names: string[]; why: string }>;
const dbMap = (allowed: DbAllowed) => ({
  order: ['low', 'db', 'high'],
  folders: { sub: 'high', db: 'db', api: 'high' },
  rootFiles: { 'a.ts': 'low', 'b.ts': 'high' },
  dbReach: { layer: 'db', from: ['api'], allowed },
});
const DB_FILES = { 'src/a.ts': '', 'src/b.ts': '', 'src/db/x.ts': 'export const open = 1;\nexport const scope = 2;\nexport type Handle = 3;\n' };
const SCOPE_ONLY = { 'api/y.ts': { names: ['scope'], why: 'the request scope stays in db' } };

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
