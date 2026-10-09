/**
 * Tests for `hippo github` CLI subcommands (Task 15).
 *
 * Strategy: subprocess via execFileSync (mirrors tests/slack-cli.test.ts) for
 * end-to-end argv/exit-code behaviour. Test 3 (backfill happy path) imports
 * the implementation directly from cli-impl.ts to inject a fake GitHubFetcher
 * without hitting the network. cli-impl.ts is intentionally kept side-effect
 * free so it can be imported in-process.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { parkInDlq, listDlq } from '../src/connectors/dlq.js';
import { githubDlq } from '../src/connectors/github/dlq.js';
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
) {
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
    // SAFETY: execFileSync throws a Node child_process error augmented with
    // status/stdout/stderr (per Node's ExecFileSyncError docs); ExecError
    // models that exact shape.
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
    const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: hippoRoot };
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
      // SAFETY: execFileSync throws a Node child_process error augmented
      // with status/stdout/stderr (per Node's ExecFileSyncError docs);
      // ExecError models that exact shape.
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
    // SAFETY: cmdGithubBackfill's only console.log call in this path prints
    // its own JSON summary object with `ingested`/`pages` counters (verified
    // by the assertions below); logs is captured exclusively around that call.
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
    parkInDlq(githubDlq, hippoRoot, {
      tenantId: 'default',
      rawPayload: '{"x":1}',
      error: 'bad envelope',
      bucket: 'unhandled',
      eventName: 'issues',
    });
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

  const SECRET = 'github-webhook-secret';
  const REPOSITORY = { full_name: 'acme/repo', private: false, owner: { login: 'acme' }, name: 'repo' };
  const issueOpenedBody = JSON.stringify({
    action: 'opened',
    issue: { number: 42, title: 'Bug', body: 'broken', user: { login: 'alice', id: 1 } },
    repository: REPOSITORY,
    sender: { login: 'alice', id: 1 },
    installation: { id: 99 },
  });
  const COMMENT_EVENTS = [
    ['issue_comment', { issue: { number: 42 } }, 'github://acme/repo/issue/42/comment/999'],
    ['pull_request_review_comment', { pull_request: { number: 7 } }, 'github://acme/repo/pull/7/review_comment/999'],
  ] as const;

  function commentBody(parent: (typeof COMMENT_EVENTS)[number][1], action: 'created' | 'deleted'): string {
    return JSON.stringify({
      action,
      ...parent,
      comment: { id: 999, body: 'I can repro', user: { login: 'bob', id: 2 } },
      repository: REPOSITORY,
      sender: { login: 'bob', id: 2 },
      installation: { id: 99 },
    });
  }

  /** Parks one signed delivery with every column the webhook route writes, and returns the row id. */
  function parkDelivery(eventName: string, body: string, secret: string = SECRET): number {
    return parkInDlq(githubDlq, hippoRoot, {
      tenantId: 'default',
      rawPayload: body,
      error: 'unroutable: installation_id=99 repo=acme/repo',
      bucket: 'unroutable',
      eventName,
      deliveryId: `delivery-${eventName}`,
      signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      installationId: '99',
      repoFullName: 'acme/repo',
    });
  }

  const replay = (id: number, ...flags: string[]) =>
    runCli(root, ['github', 'dlq', 'replay', String(id), ...flags], {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_WEBHOOK_SECRET_PREVIOUS: '',
    });
  const liveRaws = (artifactRef: string) =>
    loadAllEntries(hippoRoot).filter((e) => e.kind === 'raw' && e.artifact_ref === artifactRef);
  const retryCountOf = (id: number) =>
    listDlq(githubDlq, hippoRoot, { tenantId: 'default' }).find((row) => row.id === id)?.retryCount;

  it('dlq replay re-ingests a parked delivery and counts the retry', () => {
    const id = parkDelivery('issues', issueOpenedBody);

    const r = replay(id);

    expect(r.status).toBe(0);
    const raws = liveRaws('github://acme/repo/issue/42');
    expect(raws).toHaveLength(1);
    expect(r.stdout).toContain(`replay ok: status=replayed memory_id=${raws[0].id} retry_count=1`);
    expect(retryCountOf(id)).toBe(1);
  });

  it.each(COMMENT_EVENTS)(
    'dlq replay of a parked %s deletion archives the comment instead of storing it again',
    (eventName, parent, artifactRef) => {
      const created = parkDelivery(eventName, commentBody(parent, 'created'));
      const deleted = parkDelivery(eventName, commentBody(parent, 'deleted'));
      expect(replay(created).status).toBe(0);
      expect(liveRaws(artifactRef)).toHaveLength(1);

      const archived = replay(deleted);
      expect(archived.status).toBe(0);
      expect(archived.stdout).toContain('replay ok: status=replayed memory_id=archived retry_count=1');
      expect(liveRaws(artifactRef)).toHaveLength(0);
      expect(loadAllEntries(hippoRoot)).toHaveLength(0);

      // A second replay has nothing left to archive and still stores nothing.
      const again = replay(deleted);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('replay ok: status=replayed memory_id=(none) retry_count=2');
      expect(loadAllEntries(hippoRoot)).toHaveLength(0);
    },
  );

  it('dlq replay stores nothing when the parked body does not match its event header', () => {
    const id = parkDelivery('issues', commentBody(COMMENT_EVENTS[0][1], 'created'));

    const r = replay(id);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('replay ok: status=replayed memory_id=(none) retry_count=1');
    expect(loadAllEntries(hippoRoot)).toHaveLength(0);
    expect(retryCountOf(id)).toBe(1);
  });

  it('dlq replay refuses a row signed with another secret, and --force or the previous secret lets it through', () => {
    const id = parkDelivery('issues', issueOpenedBody, 'the-secret-before-rotation');

    const refused = replay(id);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('replay failed: status=sig_fail retry_count=1 reason=signature did not verify');
    expect(loadAllEntries(hippoRoot)).toHaveLength(0);

    const rotated = runCli(root, ['github', 'dlq', 'replay', String(id)], {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_WEBHOOK_SECRET_PREVIOUS: 'the-secret-before-rotation',
    });
    expect(rotated.status).toBe(0);
    expect(rotated.stdout).toContain('retry_count=2');
    expect(liveRaws('github://acme/repo/issue/42')).toHaveLength(1);

    const forced = replay(id, '--force');
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('retry_count=3');
    expect(retryCountOf(id)).toBe(3);
  });

  /** Backfills one page of three issues in-process and returns how many the command reports ingested. */
  async function ingestedOfThreeIssues(repo: string, max: string | boolean): Promise<number> {
    const page: GitHubBackfillPage = {
      items: [1, 2, 3].map((number) => ({
        number,
        title: `issue ${number}`,
        body: 'body text',
        user: { login: 'alice', id: 1 },
        updated_at: `2026-01-0${number}T00:00:00Z`,
      })),
      next: null,
      rateLimit: NO_RATE,
    };
    const fetcher: GitHubFetcher = async ({ url }) => (url.includes('/issues?') ? page : emptyPage());
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    try {
      await cmdGithubBackfill(hippoRoot, { repo, max }, fetcher);
      return JSON.parse(String(printed.mock.calls[0][0])).ingested.issues;
    } finally {
      vi.unstubAllEnvs();
      printed.mockRestore();
    }
  }

  it.each([
    ['2', 2],
    ['2.9', 2],
    ['0', 3],
    ['-1', 3],
    ['many', 3],
    [true, 3],
  ] as const)('backfill --max %s ingests %i of three issues', async (max, expected) => {
    expect(await ingestedOfThreeIssues('acme/widgets', max)).toBe(expected);
    const stored = loadAllEntries(hippoRoot).filter((e) => e.artifact_ref?.startsWith('github://acme/widgets/issue/'));
    expect(stored).toHaveLength(expected);
  });
});
