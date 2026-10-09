// `hippo learn --git` usage, result lines and stored rows, in process on a real store and real git repos.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleLearn } from '../src/cli/transfer.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

const SUBJECTS = [
  'docs: explain the release checklist',
  'fix: the cache key must include the tenant id',
  'fix: migrate from webpack to vite for the dashboard build',
  'fix: quote paths with spaces in the deploy script on windows',
  'fix: fixed signals',
];
const WEBPACK_SEED = 'We build the dashboard with webpack and babel loaders';
const CACHE_SEED = 'the cache key must include the tenant id';
const LEARNED = [
  'migrate from webpack to vite for the dashboard build',
  'quote paths with spaces in the deploy script on windows',
];

const temps: string[] = [];
const cwd = process.cwd();

function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  temps.push(dir);
  return dir;
}

function gitRepo(subjects: readonly string[]): string {
  const repo = temp('learn-git-repo');
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: repo, stdio: 'ignore' }); };
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  subjects.forEach((subject, i) => {
    writeFileSync(join(repo, `f${i}.txt`), subject);
    git('add', '.');
    git('commit', '-q', '-m', subject);
  });
  return repo;
}

/** A store holding one memory a migration subject supersedes and one an incoming lesson repeats. */
function seededStore(): string {
  const root = makeRoot('learn-git', { config: { embeddings: { enabled: false } } });
  temps.push(root);
  for (const text of [WEBPACK_SEED, CACHE_SEED]) {
    writeEntry(root, createMemory(text, { tags: ['seed'], tenantId: 'default' }));
  }
  return root;
}

function rowsOf(root: string): Record<string, { source: string; confidence: string; tags: string[] }> {
  return Object.fromEntries(loadAllEntries(root).map((e) => [e.content, { source: e.source, confidence: e.confidence, tags: e.tags }]));
}

async function learn(root: string, flags: Record<string, string | boolean>, repo = ''): Promise<{ status: number; stdout: string; stderr: string }> {
  const r = await runInProcess(() => handleLearn({ hippoRoot: root, args: [], flags }));
  const mask = (text: string): string => (repo ? text.replaceAll(basename(repo), '<repo>') : text);
  return { status: r.status, stdout: mask(r.stdout), stderr: mask(r.stderr) };
}

// Each case spawns a dozen git processes, which a loaded Windows box runs slowly.
const GIT_HEAVY_MS = 120_000;

beforeEach(() => {
  vi.stubEnv('HIPPO_HOME', join(temp('learn-git-home'), 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hippo learn --git (in process)', () => {
  it('prints usage and exits 1 without --git', async () => {
    const r = await learn(seededStore(), {});
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
  });

  it('with --repos prefixes each result line with the repo, stores the lessons and invalidates what a migration replaces', async () => {
    const repo = gitRepo(SUBJECTS);
    const root = seededStore();

    const first = await learn(root, { git: true, days: '30', repos: repo }, repo);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('Scanning git log for the last 30 days...');
    expect(first.stdout).toContain('[<repo>]    Invalidated 1 memories referencing "webpack"');
    expect(first.stdout).toContain('[<repo>] 2 new lessons added, 1 duplicates skipped, 1 low-information subject(s) dropped.');
    expect(first.stdout).toContain('Git learn complete: 2 new lessons added, 1 duplicates skipped across 1 repos.');

    const rows = rowsOf(root);
    expect(Object.keys(rows)).toHaveLength(4);
    for (const content of LEARNED) {
      expect(rows[content]).toMatchObject({ source: 'git-learn', confidence: 'observed' });
      expect(rows[content]!.tags).toEqual(expect.arrayContaining(['error', 'git-learned']));
    }
    expect(rows[WEBPACK_SEED]).toMatchObject({ confidence: 'stale' });
    expect(rows[WEBPACK_SEED]!.tags).toContain('invalidated');
    expect(rows[CACHE_SEED]).toMatchObject({ confidence: 'verified', tags: ['seed'] });

    const again = await learn(root, { git: true, days: '30', repos: repo }, repo);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('[<repo>] 0 new lessons added, 3 duplicates skipped, 1 low-information subject(s) dropped.');
    expect(again.stdout).toContain('Git learn complete: 0 new lessons added, 3 duplicates skipped across 1 repos.');
    expect(Object.keys(rowsOf(root))).toHaveLength(4);
  }, GIT_HEAVY_MS);

  it('without --repos reads the working directory and writes the same lessons', async () => {
    const root = seededStore();
    process.chdir(gitRepo(SUBJECTS));

    const r = await learn(root, { git: true, days: '30' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('   Invalidated 1 memories referencing "webpack"');
    expect(r.stdout).toContain('2 new lessons added, 1 duplicates skipped, 1 low-information subject(s) dropped.');
    expect(r.stdout).toContain('Git learn complete: 2 new lessons added, 1 duplicates skipped.');
    expect(r.stdout).not.toContain('across');
    expect(LEARNED.every((content) => rowsOf(root)[content]?.source === 'git-learn')).toBe(true);
  }, GIT_HEAVY_MS);

  it('says so when the directory is not a git repository', async () => {
    const root = seededStore();
    process.chdir(temp('learn-git-not-git'));

    const r = await learn(root, { git: true, days: '30' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No git history found (or not a git repository).');
    expect(r.stdout).toContain('Git learn complete: 0 new lessons added, 0 duplicates skipped.');
    expect(Object.keys(rowsOf(root))).toHaveLength(2);
  }, GIT_HEAVY_MS);

  it('says so when no commit is a fix, revert or bug', async () => {
    const root = seededStore();
    process.chdir(gitRepo(['docs: only docs here']));

    const r = await learn(root, { git: true, days: '30' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No fix/revert/bug commits found in the specified period.');
    expect(r.stdout).toContain('Git learn complete: 0 new lessons added, 0 duplicates skipped.');
    expect(Object.keys(rowsOf(root))).toHaveLength(2);
  }, GIT_HEAVY_MS);
});
