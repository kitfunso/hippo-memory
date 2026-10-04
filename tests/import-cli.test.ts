/** `hippo import --markdown` and `--vault` through the built CLI: dedup on re-import, vault deletion sync, and the refusals. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initStore, loadAllEntries } from '../src/store.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');

let cwd: string;
let hippoRoot: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'hippo-import-cli-'));
  mkdirSync(join(cwd, 'global-hippo'));
  hippoRoot = join(cwd, '.hippo');
  initStore(hippoRoot);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function hippo(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, 'import', ...args], {
    cwd,
    env: { ...process.env, HIPPO_HOME: join(cwd, 'global-hippo'), HIPPO_TENANT: 'default', HIPPO_SKIP_AUTO_INTEGRATIONS: '1' },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const contents = (): string[] => loadAllEntries(hippoRoot).map((e) => e.content).sort();

describe('hippo import --markdown', () => {
  it('a dry run lists what it would import and writes nothing; a re-import skips what is already stored', () => {
    writeFileSync(join(cwd, 'notes.md'), '# Build notes\n\n- the release build needs node 22 or newer\n- run the migration before the deploy step\n');

    const dry = hippo('--markdown', 'notes.md', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('(dry run - nothing written)');
    expect(dry.stdout).toContain('- the release build needs node 22 or newer');
    expect(contents()).toEqual([]);

    expect(hippo('--markdown', 'notes.md').stdout).toMatch(/Imported: +2/);
    expect(contents()).toEqual(['run the migration before the deploy step', 'the release build needs node 22 or newer']);

    const again = hippo('--markdown', 'notes.md');
    expect(again.stdout).toMatch(/Imported: +0/);
    expect(again.stdout).toMatch(/Skipped \(dedup\/noise\): 2/);
    expect(contents()).toHaveLength(2);
  });
});

describe('hippo import --vault', () => {
  it('imports each note once, skips unchanged notes, and archives a note deleted from the vault', () => {
    const vault = join(cwd, 'vault');
    mkdirSync(vault);
    writeFileSync(join(vault, 'deploy.md'), '# Deploy\nThe deploy runs from the main branch only.\n');
    writeFileSync(join(vault, 'cache.md'), '# Cache\nThe cache is cleared every night at two.\n');

    expect(hippo('--vault', vault, '--name', 'notes').stdout).toMatch(/Notes found: +2\n +Imported: +2/);
    expect(contents().join('\n')).toMatch(/cache is cleared[\s\S]*deploy runs/);

    expect(hippo('--vault', vault, '--name', 'notes').stdout).toMatch(/Skipped \(unchanged\): +2/);

    rmSync(join(vault, 'cache.md'));
    const synced = hippo('--vault', vault, '--name', 'notes');
    expect(synced.stdout).toMatch(/Archived \(removed\): +1/);
    expect(contents().join('\n')).not.toContain('cache is cleared');
    expect(contents().join('\n')).toContain('deploy runs');
  });

  it('refuses a missing folder, a missing --name, --global and an empty --scope', () => {
    const vault = join(cwd, 'vault');
    mkdirSync(vault);
    const cases: Array<[string[], RegExp]> = [
      [['--vault', join(cwd, 'nope'), '--name', 'n'], /Vault folder not found/],
      [['--vault', vault], /requires --name <vault>/],
      [['--vault', vault, '--name', 'n', '--global'], /does not support --global/],
      [['--vault', vault, '--name', 'n', '--scope', ' '], /--scope requires a non-empty value/],
      [['--markdown', join(cwd, 'missing.md')], /File not found/],
      [[], /Usage: hippo import/],
    ];
    for (const [args, message] of cases) {
      const r = hippo(...args);
      expect([args.join(' '), r.status]).toEqual([args.join(' '), 1]);
      expect(r.stderr).toMatch(message);
    }
    expect(contents()).toEqual([]);
  });
});
