import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-comment-history.mjs');
const BASELINE = '.comment-history-baseline.json';

type Run = (...args: string[]) => { status: number | null; stdout: string; stderr: string };
type Counts = Record<string, number>;

function withFixture(
  files: Record<string, string>,
  baseline: Counts,
  body: (f: { run: Run; baseline: () => Counts }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-comment-history-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    for (const [p, text] of Object.entries(files)) write(p, text);
    write(BASELINE, JSON.stringify(baseline));
    // SAFETY: the script only ever writes { file: count } to the baseline.
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

const TWO = '// DF1 v1.2.3 critic round 2\nexport const a = 1;\n/**\n * AT1 (docs/plans/2026-08-15-x.md)\n */\n';

describe('check-comment-history.mjs', () => {
  it('passes when the count equals the baseline', () => {
    withFixture({ 'src/a.ts': TWO }, { 'src/a.ts': 2 }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('2 lines');
    });
  });

  it('fails when a file rises, naming the file and both counts', () => {
    withFixture({ 'src/a.ts': TWO + '// codex P2 note\n' }, { 'src/a.ts': 2 }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts: 2 -> 3');
    });
  });

  it('fails on a new file that has matches, passes on a new file that has none', () => {
    withFixture({ 'src/a.ts': TWO, 'src/b.ts': '// v1.4.0 fix\n' }, { 'src/a.ts': 2 }, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/b.ts: 0 -> 1');
    });
    withFixture({ 'src/a.ts': TWO, 'src/b.ts': '// says why in one line\n' }, { 'src/a.ts': 2 }, ({ run }) => {
      expect(run().status).toBe(0);
    });
  });

  it('--update lowers the baseline and drops files with no matches; a lower count passes before that', () => {
    withFixture({ 'src/a.ts': '// DF1 only\n', 'src/b.ts': 'export const b = 1;\n' }, { 'src/a.ts': 3, 'src/b.ts': 1 }, ({ run, baseline }) => {
      const before = run();
      expect(before.status).toBe(0);
      expect(before.stdout).toContain('2 files fell below the baseline');
      expect(run('--update').status).toBe(0);
      expect(baseline()).toEqual({ 'src/a.ts': 1 });
      expect(run().stdout).not.toContain('fell below');
    });
  });

  it('counts comment lines only, not strings, templates or regex literals', () => {
    const code = [
      "const url = 'http://x.test/v1.2.3'; // AT1 trailing",
      'const tpl = `// C5 ${1 + 1} v1.9.9\n// E2 inside a template`;',
      "const re = /['\"]v1.2.3\\/\\//;",
      'const half = 4 / 2; /* DF1 block */',
      'export {};',
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, { 'src/a.ts': 2 }, ({ run }) => {
      expect(run().status).toBe(0);
      expect(run('--list', 'src/a.ts').stdout).toContain('src/a.ts:1 [ticket] AT1 trailing');
    });
  });

  it('skips domain words: layers, BM25, schema versions, the Codex product, example dates', () => {
    const code = [
      '// L2 summaries rank by BM25 and FTS5, not SHA1 or P95.',
      '// Schema v39 added the column; the Codex wrapper installs itself.',
      '// Invalid dates such as 2026-02-31 and 2026-02-29 roll forward.',
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, {}, ({ run }) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('0 lines');
    });
  });

  it('counts a real leap day and scans .mts and .cts files', () => {
    const files = { 'src/a.ts': '// Released 2028-02-29\n', 'src/b.mts': '// v2.0.0 fix\n', 'src/c.cts': '// DF1 note\n' };
    withFixture(files, {}, ({ run }) => {
      const r = run();
      expect(r.status).toBe(1);
      for (const f of ['src/a.ts', 'src/b.mts', 'src/c.cts']) expect(r.stderr).toContain(`${f}: 0 -> 1`);
    });
  });
});
