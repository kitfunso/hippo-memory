import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'scripts', 'check-store-port.mjs');
const BASELINE = '.store-port-baseline.json';

type Counts = {
  openersOutside: number;
  openersInCli: number;
  storeBranches: number;
  routesWithoutStore: number;
  sqliteOnlyRoutes: number;
  routesOnLoop: number;
  twinFunctions: number;
  sqlOutside: number;
  txLiterals: number;
  openersOutsideByFile: Record<string, number>;
  sqlOutsideByFile: Record<string, number>;
  sqliteLocalMethods: string[];
  sqliteOnlyRoutesList: string[];
  carrierFiles: number;
  carrierFilesList: string[];
};
type Run = (...args: string[]) => { status: number | null; stdout: string; stderr: string };

const zero: Counts = {
  openersOutside: 0,
  openersInCli: 0,
  storeBranches: 0,
  routesWithoutStore: 0,
  sqliteOnlyRoutes: 0,
  routesOnLoop: 0,
  twinFunctions: 0,
  sqlOutside: 0,
  txLiterals: 0,
  openersOutsideByFile: {},
  sqlOutsideByFile: {},
  sqliteLocalMethods: [],
  sqliteOnlyRoutesList: [],
  carrierFiles: 0,
  carrierFilesList: [],
};

function withFixture(files: Record<string, string>, baseline: Partial<Counts> | null, body: (f: { run: Run; baseline: () => Counts }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-store-port-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    for (const [p, text] of Object.entries(files)) write(p, text);
    if (baseline) write(BASELINE, JSON.stringify({ ...zero, ...baseline }));
    // SAFETY: the script only ever writes the Counts shape to the baseline.
    const readBaseline = () => JSON.parse(readFileSync(join(root, BASELINE), 'utf-8')) as Counts;
    body({
      run: (...args) => {
        const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8' });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      },
      baseline: readBaseline,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const list = (run: Run) =>
  Object.fromEntries(
    run('--list')
      .stdout.split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'))
      .map(([n, key]) => [key, n]),
  );

describe('check-store-port.mjs', () => {
  it('counts a plain call outside the data layer', () => {
    withFixture({ 'src/a.ts': "import { openHippoDb } from './db.js';\nexport const f = () => openHippoDb('r');\n" }, null, ({ run }) => {
      expect(list(run)).toMatchObject({ openersOutside: '1', 'src/a.ts': '1' });
    });
  });

  it('does not count calls under src/db, src/store, src/cli or src/db.ts in number 1', () => {
    const call = "export const f = () => openStore('r');\n";
    withFixture(
      { 'src/db/a.ts': call, 'src/store/b.ts': call, 'src/cli/c.ts': call, 'src/cli.ts': call, 'src/db.ts': call },
      null,
      ({ run }) => {
        expect(list(run)).toMatchObject({ openersOutside: '0', openersInCli: '2' });
      },
    );
  });

  it('counts calls of an aliased import and re-exports, not the import line', () => {
    const src = "import { openHippoDb as x } from './db.js';\nexport { onHandle } from './db.js';\nexport const f = () => x('r');\n";
    withFixture({ 'src/a.ts': src }, null, ({ run }) => {
      expect(list(run).openersOutside).toBe('2');
    });
  });

  it('ignores opener names in comments and strings', () => {
    const src = "// openHippoDb('x')\n/* openStore('y') */\nexport const s = \"onHandle('z')\";\nexport const t = `openHippoDbReadOnly('w')`;\n";
    withFixture({ 'src/a.ts': src }, null, ({ run }) => {
      expect(list(run).openersOutside).toBe('0');
    });
  });

  it('counts store ternaries and kind checks in src/api, twins, and routes without storeReady', () => {
    const api = "export function fooThroughStore() {}\nexport const f = (ctx: any) => (ctx.store ? 1 : 2);\nexport const g = (store: any) => store.kind !== 'sqlite';\nexport const h = ({ store }: any) => (store ? 1 : 2);\n";
    const server = "const V1_ROUTES = [\n  { method: 'GET', path: '/a', handler: a },\n  { method: 'GET', path: '/b', storeReady: 'base', handler: b },\n];\n";
    withFixture({ 'src/api/a.ts': api, 'src/server/route-table.ts': server }, null, ({ run }) => {
      expect(list(run)).toMatchObject({ storeBranches: '3', twinFunctions: '1', routesWithoutStore: '1' });
    });
  });

  it("counts routes on the loop: rows without `loop: 'off'` plus the seven routes outside the table, and reads 0 with no route table", () => {
    const rows = [
      "  { method: 'GET', path: '/a', handler: a },",
      "  { method: 'GET', path: '/b', storeReady: 'base', loop: 'off', handler: b },",
      "  // { method: 'GET', path: '/c', handler: c },",
      "  { method: 'GET', path: \"/loop: 'off'\", handler: d },",
      "  { method: 'GET', path: '/e', loop: 'on', handler: e },",
    ];
    withFixture({ 'src/server/route-table.ts': `const V1_ROUTES: readonly Route[] = [\n${rows.join('\n')}\n];\n` }, null, ({ run }) => {
      expect(list(run).routesOnLoop).toBe('10');
    });
    withFixture({ 'src/a.ts': 'export const a = 1;\n' }, null, ({ run }) => {
      expect(list(run).routesOnLoop).toBe('0');
    });
  });

  it("fails when a row drops `loop: 'off'`, and --update locks in a row that gains it", () => {
    const table = (second: string) => `const V1_ROUTES = [\n  { method: 'GET', path: '/a', loop: 'off', handler: a },\n  { method: 'GET', path: '/b', ${second}handler: b },\n];\n`;
    withFixture({ 'src/server/route-table.ts': table('') }, { routesWithoutStore: 2, routesOnLoop: 7 }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('routesOnLoop: 7 -> 8');
      expect(run('--update').status).toBe(1);
    });
    withFixture({ 'src/server/route-table.ts': table("loop: 'off', ") }, { routesWithoutStore: 2, routesOnLoop: 8 }, ({ run, baseline }) => {
      expect(run().status).toBe(0);
      expect(run('--update').status).toBe(0);
      expect(baseline().routesOnLoop).toBe(7);
    });
  });

  it('fails with exit 1 naming the file when a count rises', () => {
    const call = "export const f = () => openStore('r');\n";
    withFixture({ 'src/a.ts': call + call, 'src/b.ts': call }, { openersOutside: 2, openersOutsideByFile: { 'src/a.ts': 1 } }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts: 1 -> 2');
      expect(r.stderr).toContain('src/b.ts: new -> 1');
      expect(r.stderr).toContain('openersOutside: 2 -> 3');
    });
  });

  it('passes on a drop and --update lowers the baseline', () => {
    withFixture({ 'src/a.ts': "export const f = () => openStore('r');\n" }, { openersOutside: 3, openersOutsideByFile: { 'src/a.ts': 3 } }, ({ run, baseline }) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('--update');
      expect(run('--update').status).toBe(0);
      expect(baseline().openersOutside).toBe(1);
      expect(baseline().openersOutsideByFile).toEqual({ 'src/a.ts': 1 });
    });
  });

  it('--update refuses to raise a number', () => {
    withFixture({ 'src/a.ts': "export const f = () => openStore('r');\n" }, {}, ({ run, baseline }) => {
      const r = run('--update');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Refusing to raise');
      expect(baseline().openersOutside).toBe(0);
    });
  });

  it('fails on a SqliteLocal method the baseline does not list, and --update will not add it', () => {
    const local = 'export interface SqliteLocal {\n  archiveRaw(id: string): string;\n  writeEntry(id: string): void;\n}\n';
    withFixture({ 'src/store/sqlite/local.ts': local }, { sqliteLocalMethods: ['archiveRaw'] }, ({ run, baseline }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('SqliteLocal.writeEntry: unlisted -> declared');
      expect(r.stderr).not.toContain('SqliteLocal.archiveRaw');
      expect(run('--update').status).toBe(1);
      expect(baseline().sqliteLocalMethods).toEqual(['archiveRaw']);
    });
    withFixture({ 'src/store/sqlite/local.ts': local }, { sqliteLocalMethods: ['archiveRaw', 'writeEntry', 'gone'] }, ({ run, baseline }) => {
      expect(run().status).toBe(0);
      expect(run('--update').status).toBe(0);
      expect(baseline().sqliteLocalMethods).toEqual(['archiveRaw', 'writeEntry']);
    });
  });

  it('fails and names the file when a prepare call appears outside the data layer, and ignores src/store', () => {
    const call = "export const f = (db: any) => db.prepare('SELECT 1');\n";
    withFixture({ 'src/a.ts': call, 'src/store/b.ts': call }, { sqlOutside: 0, sqlOutsideByFile: {} }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts: new -> 1');
      expect(r.stderr).toContain('sqlOutside: 0 -> 1');
      expect(r.stderr).not.toContain('src/store/b.ts');
    });
  });

  it('counts a BEGIN literal outside src/db/busy.ts and not inside it', () => {
    const tx = "export const a = 'BEGIN IMMEDIATE';\nexport const b = `BEGIN`;\nexport const c = `BEGIN ${'x'}`;\n";
    withFixture({ 'src/a.ts': tx, 'src/db/busy.ts': tx }, { txLiterals: 0 }, ({ run }) => {
      expect(list(run).txLiterals).toBe('3');
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('txLiterals: 0 -> 3');
    });
  });

  it('a key the baseline never held is a first write; a key it holds still cannot rise', () => {
    const call = "export const f = (db: any) => db.prepare('SELECT 1');\n";
    const absent = { sqlOutside: undefined, sqlOutsideByFile: undefined };
    withFixture({ 'src/a.ts': call }, absent, ({ run, baseline }) => {
      expect(run().status).toBe(0);
      expect(run('--update').status).toBe(0);
      expect(baseline().sqlOutsideByFile).toEqual({ 'src/a.ts': 1 });
    });
    withFixture({ 'src/a.ts': call }, { sqlOutside: 0, sqlOutsideByFile: {} }, ({ run }) => {
      expect(run('--update').status).toBe(1);
    });
  });

  it('reads route status from the syntax tree: a comment naming storeReady is still not ported', () => {
    const table = "const V1_ROUTES = [\n  { method: 'GET', path: '/a', /* storeReady */ handler: a },\n  { method: 'GET', path: '/b', storeReady: 'base', handler: b },\n  { method: 'POST', path: '/c', sqliteOnly: 'runs the local process', handler: c },\n];\n";
    withFixture({ 'src/server/route-table.ts': table }, null, ({ run }) => {
      expect(list(run)).toMatchObject({ routesWithoutStore: '1', sqliteOnlyRoutes: '1' });
    });
  });

  it('fails on a route row whose status is not a literal, names both statuses, or is spread', () => {
    const bad = (row: string) => `const V1_ROUTES = [\n  ${row}\n];\n`;
    const cases: [string, string][] = [
      ["{ method: 'GET', path: '/a', storeReady: someIdentifier, handler: a },", 'GET /a'],
      ["{ method: 'POST', path: '/b', sqliteOnly: reason, handler: b },", 'POST /b'],
      ["{ method: 'POST', path: '/c', sqliteOnly: '', handler: c },", 'POST /c'],
      ["{ method: 'POST', path: '/d', storeReady: 'base', sqliteOnly: 'x', handler: d },", 'POST /d'],
      ['...MORE_ROUTES,', 'spread'],
    ];
    for (const [row, named] of cases) {
      withFixture({ 'src/server/route-table.ts': bad(row) }, null, ({ run }) => {
        const r = run();
        expect(r.status, row).toBe(1);
        expect(r.stderr).toContain(named);
      });
    }
  });

  it('fails and names a sqliteOnly route the baseline does not list, and --update will not add it', () => {
    const table = "const V1_ROUTES = [\n  { method: 'POST', path: '/x', sqliteOnly: 'local only', handler: x },\n  { method: 'POST', path: '/y', sqliteOnly: 'local only', handler: y },\n];\n";
    withFixture({ 'src/server/route-table.ts': table }, { sqliteOnlyRoutes: 2, sqliteOnlyRoutesList: ['POST /x'] }, ({ run, baseline }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('sqliteOnly POST /y: unlisted -> declared');
      expect(r.stderr).not.toContain('sqliteOnly POST /x');
      expect(run('--update').status).toBe(1);
      expect(baseline().sqliteOnlyRoutesList).toEqual(['POST /x']);
    });
  });

  it('exits 1 when src/server/route-table.ts has no V1_ROUTES', () => {
    withFixture({ 'src/server/route-table.ts': 'export const ROUTES = [];\n' }, null, ({ run }) => {
      const r = run('--list');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('V1_ROUTES');
    });
  });

  it('fails and names a file outside the list that calls onStore, and ignores the carrier file itself', () => {
    const use = "import { onStore } from './on-store.js';\nexport const f = (ctx: any) => onStore(ctx, () => 1);\n";
    const files = { 'src/api/on-store.ts': 'export const onStore = andThen;\n', 'src/api/old.ts': use, 'src/api/new.ts': use };
    withFixture(files, { carrierFiles: 2, carrierFilesList: ['src/api/old.ts', 'src/api/gone.ts'] }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/api/new.ts: not a carrier file -> uses andThen or onStore');
      expect(r.stderr).not.toContain('src/api/on-store.ts');
      expect(r.stderr).not.toContain('src/api/old.ts');
    });
  });

  it('passes on the real repo', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
