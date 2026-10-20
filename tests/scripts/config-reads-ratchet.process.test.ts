import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-config-reads.mjs');
const LAYERS = { folders: { api: 'api', surface: 'surface', base: 'base', store: 'store' }, rootFiles: {} };

function withFixture(
  files: Record<string, string>,
  baseline: Record<string, number>,
  body: (run: () => { status: number | null; stderr: string }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-config-reads-'));
  const write = (p: string, text: string) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  };
  try {
    write('layers.json', JSON.stringify(LAYERS));
    write('.config-reads-baseline.json', JSON.stringify(baseline));
    for (const [p, text] of Object.entries(files)) write(p, text);
    body(() => {
      const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf-8' });
      return { status: r.status, stderr: r.stderr };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const READ = 'const c = loadConfig(root);\n';

describe('check-config-reads.mjs', () => {
  it('fails on a loadConfig call in a non-surface file above the baseline', () => {
    withFixture({ 'src/store/a.ts': READ }, {}, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/store/a.ts: new -> 1');
    });
  });

  it('passes at the baseline and ignores surface files, base/config/config.ts, comments and type uses', () => {
    const files = {
      'src/store/a.ts': READ,
      'src/surface/cli/b.ts': READ,
      'src/base/config/config.ts': READ,
      'src/store/c.ts': '// loadConfig(root) is read by the caller\ntype T = typeof loadConfig;\n',
    };
    withFixture(files, { 'src/store/a.ts': 1 }, (run) => {
      expect(run().status).toBe(0);
    });
  });

  it('fails on an api read, since api code takes ctx.config', () => {
    withFixture({ 'src/api/a.ts': READ }, {}, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/api/a.ts: new -> 1');
    });
  });

  it('fails when a file adds a call past its baseline', () => {
    withFixture({ 'src/store/a.ts': READ + READ }, { 'src/store/a.ts': 1 }, (run) => {
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('src/store/a.ts: 1 -> 2');
    });
  });
});
