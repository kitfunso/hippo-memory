import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-long-lines.mjs');
const BASELINE = '.long-lines-baseline.json';

type Run = (...args: string[]) => { status: number | null; stdout: string; stderr: string };
type Baseline = Record<string, number>;

function withFixture(
  files: Record<string, string>,
  baseline: Baseline | null,
  body: (f: { run: Run; baseline: () => Baseline }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-long-lines-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    for (const [p, text] of Object.entries(files)) write(p, text);
    if (baseline) write(BASELINE, JSON.stringify(baseline));
    // SAFETY: the script only ever writes { path: count } to the baseline.
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

/** A one-line statement of exactly `width` characters. */
const lineOf = (width: number) => `const x = '${'a'.repeat(width - 13)}';\n`;

describe('check-long-lines.mjs', () => {
  it('fails when a file gains a line over 120 characters', () => {
    withFixture({ 'src/a.ts': lineOf(121) + lineOf(121) }, { 'src/a.ts': 1 }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts: 1 -> 2');
    });
  });

  it('passes when a file loses a long line, counts exactly 120 as short, and --update lowers the baseline', () => {
    withFixture({ 'src/a.ts': lineOf(121) + lineOf(120) }, { 'src/a.ts': 2 }, ({ run, baseline }) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('1 src lines over 120 characters');
      expect(run('--update').status).toBe(0);
      expect(baseline()).toEqual({ 'src/a.ts': 1 });
    });
  });

  it('fails on a new src file with a long line, and ignores scripts/ and .d.ts files', () => {
    const files = { 'src/new.ts': lineOf(200), 'src/types.d.ts': lineOf(200), 'scripts/job.mjs': lineOf(200) };
    withFixture(files, {}, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/new.ts: new -> 1');
      expect(r.stderr).not.toContain('types.d.ts');
      expect(r.stderr).not.toContain('scripts/job.mjs');
    });
  });

  it('fails on any long line when the baseline file is missing, and skips a trailing CR', () => {
    withFixture({ 'src/a.ts': lineOf(120).replace('\n', '\r\n') }, null, ({ run }) => {
      expect(run().status).toBe(0);
    });
    withFixture({ 'src/a.ts': lineOf(121) }, null, ({ run }) => {
      expect(run().status).toBe(1);
    });
  });
});
