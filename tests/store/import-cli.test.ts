/** `hippo import --markdown` and `--vault` through the CLI entry: dedup on re-import, vault deletion sync, and the refusals. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, loadEmbeddingIndex } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { startHashedEmbeddings } from '../_helpers/hashed-embedding-server.js';
import { log } from '../../src/base/util/log.js';

const savedCwd = process.cwd();
let cwd: string;
let hippoRoot: string;
beforeEach(() => {
  cwd = makeRoot('import-cli', { init: false });
  mkdirSync(join(cwd, 'global-hippo'));
  hippoRoot = join(cwd, '.hippo');
  initTestStore(hippoRoot);
  vi.stubEnv('HIPPO_HOME', join(cwd, 'global-hippo'));
  vi.stubEnv('HIPPO_TENANT', 'default');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  process.chdir(cwd);
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
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

const contents = (): string[] =>
  loadAllEntries(hippoRoot, 'default')
    .map((e) => e.content)
    .sort();

describe('hippo import --markdown', () => {
  it('a dry run lists what it would import and writes nothing; a re-import skips what is already stored', async () => {
    writeFileSync(
      join(cwd, 'notes.md'),
      '# Build notes\n\n- the release build needs node 22 or newer\n- run the migration before the deploy step\n',
    );

    const dry = await hippo('--markdown', 'notes.md', '--dry-run');
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('(dry run - nothing written)');
    expect(dry.stdout).toContain('- the release build needs node 22 or newer');
    expect(contents()).toEqual([]);

    expect((await hippo('--markdown', 'notes.md')).stdout).toMatch(/Imported: +2/);
    expect(contents()).toEqual([
      'run the migration before the deploy step',
      'the release build needs node 22 or newer',
    ]);

    const again = await hippo('--markdown', 'notes.md');
    expect(again.stdout).toMatch(/Imported: +0/);
    expect(again.stdout).toMatch(/Skipped \(dedup\/noise\): 2/);
    expect(contents()).toHaveLength(2);
  });
});

describe('hippo import embedding backfill', () => {
  const notes =
    '# Build notes\n\n- the release build needs node 22 or newer\n- run the migration before the deploy step\n';
  const FILE = ['--markdown', 'notes.md'];
  const VAULT = ['--vault', 'vault', '--name', 'notes'];

  /** Runs `hippo import <args>` against an embedding server and returns the warnings logged before the command returned. */
  async function importWithEmbeddings(
    status: number,
    args: readonly string[] = FILE,
  ): Promise<{ stdout: string; warnings: string[] }> {
    const embeddings = await startHashedEmbeddings();
    embeddings.setStatus(status);
    const config = { embeddings: { provider: 'openai', model: 'hashed-16', apiBaseUrl: embeddings.url } };
    writeFileSync(join(hippoRoot, 'config.json'), JSON.stringify(config));
    vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
    writeFileSync(join(cwd, 'notes.md'), notes);
    mkdirSync(join(cwd, 'vault'));
    writeFileSync(join(cwd, 'vault', 'deploy.md'), '# Deploy\nThe deploy runs from the main branch only.\n');
    writeFileSync(join(cwd, 'vault', 'cache.md'), '# Cache\nThe cache is cleared every night at two.\n');
    const warnings: string[] = [];
    const warn = vi.spyOn(log, 'warn').mockImplementation((line) => {
      warnings.push(line);
    });
    try {
      const { stdout } = await hippo(...args);
      return { stdout, warnings };
    } finally {
      warn.mockRestore();
      await embeddings.close();
    }
  }

  // The command's store runtime closes as the command returns, so the backfill must settle by then.
  it('embeds the imported rows before the command returns', async () => {
    const { stdout, warnings } = await importWithEmbeddings(200);
    expect(stdout).toMatch(/Imported: +2/);
    expect(warnings).toEqual([]);
    expect(Object.keys(loadEmbeddingIndex(hippoRoot))).toHaveLength(2);
  });

  it('reports a backfill the embedding server fails before the command returns', async () => {
    const { stdout, warnings } = await importWithEmbeddings(500);
    expect(stdout).toMatch(/Imported: +2/);
    expect(contents()).toHaveLength(2);
    expect(warnings).toEqual([
      expect.stringMatching(/^import: embedding backfill failed \(.+\); 2 rows have no vector; run 'hippo embed'/),
    ]);
  });

  it('embeds the rows a vault import writes before the command returns', async () => {
    const { stdout, warnings } = await importWithEmbeddings(200, VAULT);
    expect(stdout).toMatch(/Imported: +2/);
    expect(warnings).toEqual([]);
    expect(Object.keys(loadEmbeddingIndex(hippoRoot))).toHaveLength(2);
  });

  it('reports a vault backfill the embedding server fails before the command returns', async () => {
    const { stdout, warnings } = await importWithEmbeddings(500, VAULT);
    expect(stdout).toMatch(/Imported: +2/);
    expect(warnings).toEqual([
      expect.stringMatching(/^import: embedding backfill failed \(.+\); 2 rows have no vector; run 'hippo embed'/),
    ]);
  });

  it('a backfill that fails still imports, and warns with the rows left without a vector and the command that finishes them', async () => {
    // An API provider with no key makes the backfill reject after the rows are saved.
    writeFileSync(join(hippoRoot, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', model: 'm' } }));
    writeFileSync(join(cwd, 'notes.md'), notes);
    vi.stubEnv('OPENAI_API_KEY', '');
    const warnings: string[] = [];
    const warn = vi.spyOn(log, 'warn').mockImplementation((line) => {
      warnings.push(line);
    });

    const r = await hippo('--markdown', 'notes.md').finally(() => warn.mockRestore());

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Imported: +2/);
    expect(contents()).toHaveLength(2);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^import: embedding backfill failed \(.*OPENAI_API_KEY is not set.*\); 2 rows have no vector; run 'hippo embed' to backfill$/,
      ),
    ]);
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
