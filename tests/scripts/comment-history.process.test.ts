import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'checks', 'check-comment-history.mjs');

type Run = (...args: string[]) => { status: number | null; stdout: string; stderr: string };

function withFixture(files: Record<string, string>, body: (run: Run) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-comment-history-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    body((...args) => {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8' });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const TWO = '// DF1 v1.2.3 critic round 2\nexport const a = 1;\n/**\n * AT1 (docs/plans/2026-08-15-x.md)\n */\n';

describe('check-comment-history.mjs', () => {
  it('passes when every comment says why without history', () => {
    withFixture({ 'src/a.ts': '// says why in one line\nexport const a = 1;\n' }, (run) => {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Comment history check OK');
    });
  });

  it('fails on a single history line in any file, naming the file and line', () => {
    withFixture({ 'src/a.ts': TWO, 'src/b.ts': '// v1.4.0 fix\n' }, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts:1 DF1 v1.2.3 critic round 2');
      expect(r.stderr).toContain('src/a.ts:4 * AT1 (docs/plans/2026-08-15-x.md)');
      expect(r.stderr).toContain('src/b.ts:1 v1.4.0 fix');
    });
  });

  it('counts comment lines only, not strings, templates or regex literals', () => {
    const code = [
      "const url = 'http://x.test/v1.2.3'; // AT1 trailing",
      'const tpl = `// C5 ${1 + 1} v1.9.9\n// E2 inside a template`;',
      'const re = /[\'"]v1.2.3\\/\\//;',
      'const half = 4 / 2; /* DF1 block */',
      'export {};',
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, (run) => {
      const listed = run('--list', 'src/a.ts').stdout.trim().split('\n');
      expect(listed).toHaveLength(2);
      expect(listed).toContain('src/a.ts:1 [ticket] AT1 trailing');
      expect(run().status).toBe(1);
    });
  });

  it('skips domain words: layers, markdown headers, BM25, schema versions, the Codex product, example dates', () => {
    const code = [
      '// L2 summaries rank by BM25 and FTS5, not SHA1 or P95.',
      '// Each skill renders as an H2 header under the H1 title.',
      '// Schema v39 added the column; the Codex wrapper installs itself.',
      '// Invalid dates such as 2026-02-31 and 2026-02-29 roll forward.',
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, (run) => {
      expect(run().status).toBe(0);
    });
  });

  it('fails on a comment line holding one word', () => {
    const code = ['// A wrapped comment whose last word fell onto its own', '// line.', 'export {};', ''].join('\n');
    withFixture({ 'src/a.ts': code, 'src/b.ts': '// Two words.\n' }, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/a.ts:2 // line.');
      expect(r.stderr).not.toContain('src/b.ts');
    });
  });

  it('reads a one-word line inside a template literal or after code as no orphan', () => {
    const code = ['const help = `', '// usage', '`;', 'const n = 1; // done', 'export { help, n };', ''].join('\n');
    withFixture({ 'src/a.ts': code }, (run) => {
      expect(run().status).toBe(0);
    });
  });

  it('fails on a doc comment ending in one word alone, not on a one-word doc', () => {
    const code = [
      '/** A wrapped doc whose last word fell onto its own',
      ' * line. */',
      'export const a = 1;',
      '/**',
      ' * A doc closed on a line of its own after a one-word',
      ' * ending.',
      ' */',
      'export const b = 1;',
      '/** Word. */',
      'export const c = 1;',
      '/**',
      ' * Word.',
      ' */',
      'export const d = 1;',
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, (run) => {
      const listed = run('--list').stdout.trim().split('\n');
      expect(listed).toEqual(['src/a.ts:2 [orphan] * line.', 'src/a.ts:6 [orphan] * ending.']);
      expect(run().status).toBe(1);
    });
  });

  it('reads a lone JSDoc tag or code fence as no doc ending, and checks the prose before them', () => {
    const code = [
      '/**',
      ' * Kept out of the published types.',
      ' * @internal',
      ' */',
      'export const a = 1;',
      '/**',
      ' * Call it once per folder:',
      ' * ```ts',
      ' * setup();',
      ' * ```',
      ' */',
      'export const b = 1;',
      '/**',
      ' * A wrapped doc whose last prose word fell onto its own',
      ' * line.',
      ' * @deprecated',
      ' */',
      'export const c = 1;',
      '',
    ].join('\n');
    withFixture({ 'src/a.ts': code }, (run) => {
      expect(run('--list').stdout.trim().split('\n')).toEqual(['src/a.ts:15 [orphan] * line.']);
    });
  });

  it('counts a real leap day and scans .mts and .cts files', () => {
    const files = {
      'src/a.ts': '// Released 2028-02-29\n',
      'src/b.mts': '// v2.0.0 fix\n',
      'src/c.cts': '// DF1 note\n',
    };
    withFixture(files, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      for (const f of ['src/a.ts', 'src/b.mts', 'src/c.cts']) expect(r.stderr).toContain(`${f}:1 `);
    });
  });
});
