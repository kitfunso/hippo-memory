/**
 * Tests for `hippo github` CLI subcommands (Task 15).
 *
 * Strategy: subprocess via execFileSync (mirrors tests/slack-cli.test.ts) for
 * end-to-end argv/exit-code behaviour. Test 3 (backfill happy path) imports
 * the implementation directly from cli-impl.ts to inject a fake GitHubFetcher
 * without hitting the network. cli-impl.ts is intentionally kept side-effect
 * free so it can be imported in-process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { initStore, loadAllEntries } from '../src/store.js';
import { writeToDlq } from '../src/connectors/github/dlq.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { cmdGithubBackfill } from '../src/connectors/github/cli-impl.js';
import type {
  GitHubFetcher,
  GitHubBackfillPage,
} from '../src/connectors/github/octokit-client.js';

const CLI = resolve(__dirname, '..', 'bin', 'hippo.js');

interface ExecError extends Error {
  status?: number;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  if (!existsSync(CLI)) {
    throw new Error(
      `bin/hippo.js not found at ${CLI} - run \`npm run build\` first`,
    );
  }
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo'), ...extraEnv },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as ExecError;
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

const NO_RATE = { sleepSeconds: 0, reason: 'none' as const };

function emptyPage(): GitHubBackfillPage {
  return { items: [], next: null, rateLimit: NO_RATE };
}

describe('hippo github CLI', () => {
  let root: string;
  let hippoRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-github-cli-'));
    hippoRoot = join(root, '.hippo');
    initStore(hippoRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('backfill without --repo exits 2 with usage', () => {
    const r = runCli(root, ['github', 'backfill'], { GITHUB_TOKEN: 'x' });
    expect(r.status).toBe(2);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/--repo/);
    expect(out).toMatch(/owner\/name/);
  });

  it('backfill --repo without GITHUB_TOKEN exits 2 with actionable error', () => {
    const env = { ...process.env, HIPPO_HOME: hippoRoot };
    delete env.GITHUB_TOKEN;
    let status = 0;
    let stderr = '';
    try {
      execFileSync('node', [CLI, 'github', 'backfill', '--repo', 'a/b'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (e) {
      const err = e as ExecError;
      status = err.status ?? 1;
      stderr = err.stderr?.toString() ?? '';
    }
    expect(status).toBe(2);
    expect(stderr).toMatch(/GITHUB_TOKEN/);
  });

  it('backfill --repo with GITHUB_TOKEN + injected fetcher ingests one issue', async () => {
    // Single issue page, then empty pages on the other two streams.
    const pages: GitHubBackfillPage[] = [
      {
        items: [
          {
            number: 1,
            title: 'hello',
            body: 'world',
            user: { login: 'alice', id: 1 },
            updated_at: '2026-01-01T00:00:00Z',
          },
        ],
        next: null,
        rateLimit: NO_RATE,
      },
    ];
    let issuesPageIdx = 0;
    const fetcher: GitHubFetcher = async ({ url }) => {
      if (url.includes('/issues?')) {
        const p = pages[issuesPageIdx++];
        return p ?? emptyPage();
      }
      return emptyPage();
    };
    const prevToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fake-token';
    // Capture stdout so we can parse the JSON result.
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
      await cmdGithubBackfill(
        hippoRoot,
        { repo: 'acme/widgets' },
        fetcher,
      );
    } finally {
      console.log = origLog;
      if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevToken;
    }
    const json = JSON.parse(logs.join('\n')) as {
      ingested: { issues: number };
      pages: { issues: number };
    };
    expect(json.ingested.issues).toBe(1);
    expect(json.pages.issues).toBe(1);
    // Verify the row actually landed in the store.
    const all = loadAllEntries(hippoRoot);
    expect(all.length).toBeGreaterThan(0);
  });

  it('dlq list on empty DLQ prints "no entries"', () => {
    const r = runCli(root, ['github', 'dlq', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no entries/);
  });

  it('dlq list with rows prints bucket and tenant', () => {
    const db = openHippoDb(hippoRoot);
    try {
      writeToDlq(db, {
        tenantId: 'default',
        rawPayload: '{"x":1}',
        error: 'bad envelope',
        bucket: 'unhandled',
        eventName: 'issues',
      });
    } finally {
      closeHippoDb(db);
    }
    const r = runCli(root, ['github', 'dlq', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unhandled/);
    expect(r.stdout).toMatch(/default/);
    expect(r.stdout).toMatch(/bad envelope/);
  });

  it('dlq replay with invalid id exits 1 with not-found message', () => {
    const r = runCli(root, ['github', 'dlq', 'replay', '99999']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not[_ ]found|not found/i);
  });
});
