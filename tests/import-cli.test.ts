/** `hippo import --markdown` and `--vault` through the CLI entry: dedup on re-import, vault deletion sync, and the refusals. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { runCli } from '../src/cli.js';
import { runInProcess } from './_helpers/run-in-process.js';

const savedCwd = process.cwd();
let cwd: string;
let hippoRoot: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'hippo-import-cli-'));
  mkdirSync(join(cwd, 'global-hippo'));
  hippoRoot = join(cwd, '.hippo');
  initStore(hippoRoot);
  vi.stubEnv('HIPPO_HOME', join(cwd, 'global-hippo'));
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

// A verb that sets process.exitCode instead of exiting reports it here, as the real process would on exit.
async function runVerb(...args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    return { status: r.status || Number(process.exitCode ?? 0), stdout: r.stdout, stderr: r.stderr };
  } finally {
    process.exitCode = undefined;
  }
}

const hippo = (...args: string[]) => runVerb('import', ...args);

const contents = (): string[] => loadAllEntries(hippoRoot).map((e) => e.content).sort();

describe('hippo import --markdown', () => {
  it('a dry run lists what it would import and writes nothing; a re-import skips what is already stored', async () => {
    writeFileSync(join(cwd, 'notes.md'), '# Build notes\n\n- the release build needs node 22 or newer\n- run the migration before the deploy step\n');

    const dry = await hippo('--markdown', 'notes.md', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('(dry run - nothing written)');
    expect(dry.stdout).toContain('- the release build needs node 22 or newer');
    expect(contents()).toEqual([]);

    expect((await hippo('--markdown', 'notes.md')).stdout).toMatch(/Imported: +2/);
    expect(contents()).toEqual(['run the migration before the deploy step', 'the release build needs node 22 or newer']);

    const again = await hippo('--markdown', 'notes.md');
    expect(again.stdout).toMatch(/Imported: +0/);
    expect(again.stdout).toMatch(/Skipped \(dedup\/noise\): 2/);
    expect(contents()).toHaveLength(2);
  });
});

describe('hippo import embedding backfill', () => {
  it('a backfill that fails still imports, and warns with the rows left without a vector and the command that finishes them', async () => {
    // An API provider with no key makes the backfill reject after the rows are saved.
    writeFileSync(join(hippoRoot, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }));
    writeFileSync(join(cwd, 'notes.md'), '# Build notes\n\n- the release build needs node 22 or newer\n- run the migration before the deploy step\n');

    vi.stubEnv('OPENAI_API_KEY', '');
    const r = await hippo('--markdown', 'notes.md');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Imported: +2/);
    expect(contents()).toHaveLength(2);
    expect(r.stderr).toMatch(/warn: import: embedding backfill failed \(.*OPENAI_API_KEY is not set.*\); 2 rows have no vector; run 'hippo embed' to backfill/);
  });
});

describe('hippo import --vault', () => {
  it('imports each note once, skips unchanged notes, and archives a note deleted from the vault', async () => {
    const vault = join(cwd, 'vault');
    mkdirSync(vault);
    writeFileSync(join(vault, 'deploy.md'), '# Deploy\nThe deploy runs from the main branch only.\n');
    writeFileSync(join(vault, 'cache.md'), '# Cache\nThe cache is cleared every night at two.\n');

    expect((await hippo('--vault', vault, '--name', 'notes')).stdout).toMatch(/Notes found: +2\n +Imported: +2/);
    expect(contents().join('\n')).toMatch(/cache is cleared[\s\S]*deploy runs/);

    expect((await hippo('--vault', vault, '--name', 'notes')).stdout).toMatch(/Skipped \(unchanged\): +2/);

    rmSync(join(vault, 'cache.md'));
    const synced = await hippo('--vault', vault, '--name', 'notes');
    expect(synced.stdout).toMatch(/Archived \(removed\): +1/);
    expect(contents().join('\n')).not.toContain('cache is cleared');
    expect(contents().join('\n')).toContain('deploy runs');
  });

  it('refuses a missing folder, a missing --name, --global and an empty --scope', async () => {
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
      const r = await hippo(...args);
      expect([args.join(' '), r.status]).toEqual([args.join(' '), 1]);
      expect(r.stderr).toMatch(message);
    }
    expect(contents()).toEqual([]);
  });
});
