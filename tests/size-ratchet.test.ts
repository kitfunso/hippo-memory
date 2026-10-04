import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-size-ratchet.mjs');
const BASELINE = '.size-baseline.json';

type Run = (...args: string[]) => { status: number | null; stdout: string; stderr: string };
type Baseline = { files?: Record<string, number>; functions?: Record<string, number> };

function withFixture(files: Record<string, string>, baseline: Baseline, body: (f: { run: Run; baseline: () => Baseline }) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-size-ratchet-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    for (const [p, text] of Object.entries(files)) write(p, text);
    write(BASELINE, JSON.stringify(baseline));
    // SAFETY: the script only ever writes { files, functions } of counts to the baseline.
    const readBaseline = () => JSON.parse(readFileSync(join(root, BASELINE), 'utf-8')) as Baseline;
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

/** A function declaration spanning exactly `lines` lines. */
const fn = (name: string, lines: number) => `export function ${name}() {\n${'  void 0;\n'.repeat(lines - 2)}}\n`;

describe('check-size-ratchet.mjs', () => {
  it('passes a small file with an empty baseline', () => {
    withFixture({ 'src/a.ts': fn('small', 80) }, {}, ({ run }) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('0 files over 800 lines, 0 functions over 80');
    });
  });

  it('fails on a new 81-line function, naming it', () => {
    withFixture({ 'src/a.ts': fn('small', 80) + fn('big', 81) }, {}, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts:big: new -> 81');
    });
  });

  it('fails when a baselined function grows', () => {
    withFixture({ 'src/a.ts': fn('big', 95) }, { functions: { 'src/a.ts:big': 90 } }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts:big: 90 -> 95');
    });
  });

  it('passes when a baselined function shrinks, and --update lowers the baseline', () => {
    withFixture({ 'src/a.ts': fn('big', 85) + fn('gone', 20) }, { functions: { 'src/a.ts:big': 90, 'src/a.ts:gone': 100 } }, ({ run, baseline }) => {
      const before = run();
      expect(before.status).toBe(0);
      expect(before.stdout).toContain('2 offenders shrank or went');
      expect(run('--update').status).toBe(0);
      expect(baseline()).toEqual({ files: {}, functions: { 'src/a.ts:big': 85 } });
      expect(run().stdout).not.toContain('shrank');
    });
  });

  it('fails on an 801-line file and skips .d.ts files', () => {
    const long = 'export const x = 1;\n'.repeat(801);
    withFixture({ 'src/long.ts': long, 'src/types.d.ts': long }, {}, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/long.ts: new -> 801');
      expect(r.stderr).not.toContain('types.d.ts');
    });
  });

  it('keys methods, nested and anonymous functions by name, not line number', () => {
    const body = '  void 0;\n'.repeat(85);
    const code = [
      `export class Store {\n  save() {\n${body}  }\n}`,
      `export function outer() {\n  const inner = () => {\n${body}  };\n  return inner;\n}`,
      `export const run = () => [1].map(() => {\n${body}});`,
      `export function twice() {\n  [1].map(() => {\n${body}  });\n  [2].map(() => {\n${body}  });\n}`,
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, {}, ({ run, baseline }) => {
      expect(run('--update').status).toBe(0);
      expect(Object.keys(baseline().functions ?? {})).toEqual([
        'src/a.ts:Store.save',
        'src/a.ts:outer',
        'src/a.ts:outer > inner',
        'src/a.ts:run',
        'src/a.ts:run > map(callback)',
        'src/a.ts:twice',
        'src/a.ts:twice > map(callback)',
        'src/a.ts:twice > map(callback) #2',
      ]);
    });
  });
});
