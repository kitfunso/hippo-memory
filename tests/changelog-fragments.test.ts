import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'changelog-fragments.mjs');
const OLD = '# Changelog\n\n## 1.9.9 - 2026-01-01\n\n### Fixed\n\n- Old.\n';

function withFixture(
  fragments: Record<string, string>,
  body: (f: { run: (...args: string[]) => { status: number | null; stderr: string }; read: (p: string) => string; has: (p: string) => boolean }) => void,
  changelog = OLD,
) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-fragments-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '2.0.0' }));
    writeFileSync(join(root, 'CHANGELOG.md'), changelog);
    mkdirSync(join(root, 'changelog.d'));
    writeFileSync(join(root, 'changelog.d', 'README.md'), '# changelog.d\n');
    for (const [name, text] of Object.entries(fragments)) writeFileSync(join(root, 'changelog.d', name), text);
    body({
      run: (...args) => {
        const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8' });
        return { status: r.status, stderr: r.stderr };
      },
      read: (p) => readFileSync(join(root, p), 'utf-8'),
      has: (p) => existsSync(join(root, p)),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('changelog-fragments.mjs', () => {
  it('folds fragments under shared headings, known headings first, and deletes them', () => {
    const fragments = {
      'fix-b.md': '### Fixed\n\n- B fix.\n\n### Notes\n\n- B note.\n',
      'feat-a.md': '### Fixed\n\n- A fix.\n\n### Added\n\n- A feature.\n',
    };
    withFixture(fragments, ({ run, read, has }) => {
      expect(run('fold', '2026-09-22').status).toBe(0);
      expect(read('CHANGELOG.md')).toBe(
        '# Changelog\n\n## 2.0.0 - 2026-09-22\n\n### Added\n\n- A feature.\n\n### Fixed\n\n- A fix.\n- B fix.\n\n' +
          '### Notes\n\n- B note.\n\n## 1.9.9 - 2026-01-01\n\n### Fixed\n\n- Old.\n',
      );
      expect(has('changelog.d/feat-a.md') || has('changelog.d/fix-b.md')).toBe(false);
      expect(has('changelog.d/README.md')).toBe(true);
      expect(run('check').status).toBe(0);
    });
  });

  it('refuses to fold into a version that already has a section, and changes nothing', () => {
    const done = '# Changelog\n\n## 2.0.0 - 2026-09-01\n\n- Done.\n';
    withFixture({ 'fix-c.md': '### Fixed\n\n- C.\n' }, ({ run, read, has }) => {
      const r = run('fold', '2026-09-22');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('already has a ## 2.0.0 section');
      expect(read('CHANGELOG.md')).toBe(done);
      expect(has('changelog.d/fix-c.md')).toBe(true);
    }, done);
  });

  it('refuses a fragment with a ## heading or text outside a ### heading', () => {
    withFixture({ 'x.md': '### Fixed\n\n- X.\n\n## 1.0.0\n\n- Stray.\n' }, ({ run, read }) => {
      expect(run('fold', '2026-09-22').status).toBe(1);
      expect(read('CHANGELOG.md')).toBe(OLD);
    });
    withFixture({ 'y.md': '- Y with no heading.\n' }, ({ run }) => {
      expect(run('fold', '2026-09-22').status).toBe(1);
    });
  });

  it('check fails while a fragment is left and passes on README.md alone', () => {
    withFixture({ 'fix-c.md': '### Fixed\n\n- C.\n' }, ({ run }) => {
      const r = run('check');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('fix-c.md');
    });
    withFixture({}, ({ run }) => expect(run('check').status).toBe(0));
  });
});
