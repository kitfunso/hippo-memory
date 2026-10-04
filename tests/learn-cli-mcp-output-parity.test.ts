// Pins what `hippo learn --git` and MCP hippo_learn print and the rows each writes, in process on a real store,
// so moving both onto one api.learn cannot change a byte, a tag, a source or an invalidation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cmdLearn } from '../src/cli/transfer.js';
import { handleMcpRequest } from '../src/mcp/request.js';
import type { McpContext } from '../src/mcp/protocol.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

const SUBJECTS = [
  'docs: explain the release checklist',
  'fix: the cache key must include the tenant id',
  'fix: migrate from webpack to vite for the dashboard build',
  'fix: quote paths with spaces in the deploy script on windows',
  'fix: fixed signals',
];

const temps: string[] = [];
const cwd = process.cwd();

function temp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hippo-${label}-`));
  temps.push(dir);
  return dir;
}

function gitRepo(subjects: readonly string[]): string {
  const repo = temp('learn-parity-repo');
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
  const root = makeRoot('learn-parity', { config: { embeddings: { enabled: false } } });
  temps.push(root);
  for (const text of ['We build the dashboard with webpack and babel loaders', 'the cache key must include the tenant id']) {
    writeEntry(root, createMemory(text, { tags: ['seed'], tenantId: 'default' }));
  }
  return root;
}

/** Every memory row and every audit row, with machine-specific path tags folded to one marker. */
function effects(root: string): string {
  const memories = loadAllEntries(root)
    .map((e) => ({
      content: e.content,
      layer: e.layer,
      tags: [...new Set(e.tags.map((t) => (t.startsWith('path:') ? 'path:*' : t)))].sort(),
      source: e.source,
      confidence: e.confidence,
      schema_fit: e.schema_fit,
      half_life_days: e.half_life_days,
    }))
    .sort((a, b) => a.content.localeCompare(b.content));
  const db = openHippoDb(root);
  try {
    const audit = db.prepare(`SELECT tenant_id, actor, op FROM audit_log ORDER BY id`).all();
    return JSON.stringify({ memories, audit }, null, 1);
  } finally {
    closeHippoDb(db);
  }
}

async function cli(root: string, flags: Record<string, string | boolean>, label = ''): Promise<string> {
  const r = await runInProcess(() => cmdLearn(root, flags));
  return `$ learn ${label} -> ${r.status}\n--- stdout\n${r.stdout}--- stderr\n${r.stderr}`;
}

async function mcp(ctx: McpContext, days: number): Promise<string> {
  try {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_learn', arguments: { days } } }, ctx);
    return JSON.stringify(res?.error ?? res?.result);
  } catch (error) {
    return `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
}

// Each case spawns a dozen git processes, which a loaded Windows box runs slowly.
const GIT_HEAVY_MS = 120_000;

beforeEach(() => {
  vi.stubEnv('HIPPO_HOME', join(temp('learn-parity-home'), 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hippo learn --git (in process)', () => {
  it('prints the same lines and writes the same rows for --repos, the working directory and the edge cases', async () => {
    const repo = gitRepo(SUBJECTS);
    const viaRepos = seededStore();
    const viaCwd = seededStore();
    const transcript: string[] = [];

    transcript.push(await cli(viaRepos, {}, '(no --git)'));
    transcript.push(await cli(viaRepos, { git: true, days: '30', repos: repo }, '--repos'));
    transcript.push(await cli(viaRepos, { git: true, days: '30', repos: repo }, '--repos (again)'));
    process.chdir(repo);
    transcript.push(await cli(viaCwd, { git: true, days: '30' }, '(cwd)'));
    process.chdir(temp('learn-parity-not-git'));
    transcript.push(await cli(viaCwd, { git: true, days: '30' }, '(not a repo)'));
    process.chdir(gitRepo(['docs: only docs here']));
    transcript.push(await cli(viaCwd, { git: true, days: '30' }, '(no lessons)'));

    expect(transcript.join('\n').replaceAll(basename(repo), '<repo>')).toMatchSnapshot();
    expect(effects(viaRepos)).toMatchSnapshot();
    expect(effects(viaCwd)).toBe(effects(viaRepos));
  }, GIT_HEAVY_MS);
});

describe('MCP hippo_learn', () => {
  it('returns the same text and writes the same rows, and refuses a caller that is not the host admin', async () => {
    const root = seededStore();
    const stdio: McpContext = { hippoRoot: root, tenantId: 'default', actor: 'mcp' };
    const results: string[] = [];

    process.chdir(gitRepo(SUBJECTS));
    results.push(await mcp(stdio, 30));
    results.push(await mcp(stdio, 30));
    results.push(await mcp({ ...stdio, actor: 'api_key:hk_member', role: 'member' }, 30));
    process.chdir(temp('learn-parity-not-git'));
    results.push(await mcp(stdio, 30));
    process.chdir(gitRepo(['docs: only docs here']));
    results.push(await mcp(stdio, 30));

    expect(results).toMatchSnapshot();
    expect(effects(root)).toMatchSnapshot();
  }, GIT_HEAVY_MS);
});
