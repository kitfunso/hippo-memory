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
