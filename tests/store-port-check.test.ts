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
  twinFunctions: number;
  openersOutsideByFile: Record<string, number>;
  sqliteLocalMethods: string[];
};
type Run = (...args: string[]) => { status: number | null; stdout: string; stderr: string };

const zero: Counts = {
  openersOutside: 0,
  openersInCli: 0,
  storeBranches: 0,
  routesWithoutStore: 0,
  twinFunctions: 0,
  openersOutsideByFile: {},
  sqliteLocalMethods: [],
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
    withFixture({ 'src/api/a.ts': api, 'src/server.ts': server }, null, ({ run }) => {
      expect(list(run)).toMatchObject({ storeBranches: '3', twinFunctions: '1', routesWithoutStore: '1' });
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

  it('passes on the real repo', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: REPO, encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
  });
});
