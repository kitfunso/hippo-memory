import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { parkInDlq } from '../../src/surface/connectors/dlq.js';
import { githubDlq } from '../../src/surface/connectors/github/dlq.js';
import { hostMismatch, parseGitHubEnterpriseUrl } from '../../src/surface/connectors/github/site.js';
import { GitHubPayloadParseError, handleGitHub, parseParkedPayload } from '../../src/surface/cli/github.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { makeStore } from '../_helpers/make-root.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { loadAllEntries } from '../_helpers/root-forms.js';

function runCli(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  return runCliAs(args, {
    cwd,
    env: { ...process.env, HIPPO_HOME: join(cwd, '.hippo'), ...extraEnv },
  });
}

function stubGitHubIssues(issues: readonly JsonValue[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string | URL) =>
        new Response(JSON.stringify(String(url).includes('/issues?') ? issues : []), { status: 200 }),
    ),
  );
}

describe('hippo github CLI', () => {
  let root: string;
  let hippoRoot: string;

  beforeEach(() => {
    ({ base: root, root: hippoRoot } = makeStore('github-cli'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('backfill without --repo exits 2 with usage', async () => {
    const r = await runCli(root, ['github', 'backfill'], { GITHUB_TOKEN: 'x' });
    expect(r.status).toBe(2);
    const out = r.stdout + r.stderr;
    expect(out).toMatch(/--repo/);
    expect(out).toMatch(/owner\/name/);
  });

  it('backfill --repo without GITHUB_TOKEN exits 2 with actionable error', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: hippoRoot };
    const { status, stderr } = await runCliAs(['github', 'backfill', '--repo', 'a/b'], { cwd: root, env });
    expect(status).toBe(2);
    expect(stderr).toMatch(/GITHUB_TOKEN/);
  });

  it('backfill --repo with GITHUB_TOKEN + stubbed fetch ingests one issue', async () => {
    stubGitHubIssues([
      {
        number: 1,
        title: 'hello',
        body: 'world',
        user: { login: 'alice', id: 1 },
        author_association: 'MEMBER',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    try {
      await handleGitHub({
        hippoRoot,
        tenantId: 'default',
        args: ['backfill'],
        flags: { repo: 'acme/widgets' },
      });
    } finally {
      console.log = origLog;
    }
    // SAFETY: the backfill command's only console.log call in this path prints
    // its own JSON summary object with `ingested`/`pages` counters (verified
    // by the assertions below); logs is captured exclusively around that call.
    const json = JSON.parse(logs.join('\n')) as {
      ingested: { issues: number };
      pages: { issues: number };
    };
    expect(json.ingested.issues).toBe(1);
    expect(json.pages.issues).toBe(1);
    const all = loadAllEntries(hippoRoot, 'default');
    expect(all.map((e) => e.content)).toEqual(['hello\n\nworld']);
  });

  it('A16. backfill with GITHUB_ENTERPRISE_URL set calls the GHES API and stores host refs', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        const issues = [
          {
            number: 1,
            title: 'hello',
            body: 'world',
            user: { login: 'alice', id: 1 },
            author_association: 'MEMBER',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ];
        return new Response(JSON.stringify(String(url).includes('/issues?') ? issues : []), { status: 200 });
      }),
    );
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    vi.stubEnv('GITHUB_ENTERPRISE_URL', 'https://ghes.example.com');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleGitHub({ hippoRoot, tenantId: 'default', args: ['backfill'], flags: { repo: 'acme/widgets' } });
    } finally {
      printed.mockRestore();
    }
    expect(urls.length).toBeGreaterThanOrEqual(3);
    for (const url of urls) expect(url.startsWith('https://ghes.example.com/api/v3/repos/acme/widgets/')).toBe(true);
    const raws = loadAllEntries(hippoRoot, 'default').filter((e) => e.kind === 'raw');
    expect(raws.map((e) => e.artifactRef)).toEqual(['github://ghes.example.com/acme/widgets/issue/1']);
    expect(raws.map((e) => e.scope)).toEqual(['github:private:ghes.example.com/acme/widgets']);
  });

  it('A17. a bad GITHUB_ENTERPRISE_URL exits 2 naming the setting, before any fetch', async () => {
    stubGitHubIssues([]);
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    vi.stubEnv('GITHUB_ENTERPRISE_URL', 'https://ghe');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        handleGitHub({ hippoRoot, tenantId: 'default', args: ['backfill'], flags: { repo: 'a/b' } }),
      ).rejects.toMatchObject({ code: 2 });
      expect(errors.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/GITHUB_ENTERPRISE_URL/);
    } finally {
      errors.mockRestore();
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('A25. --repo with a host or a path exits 2 with usage and writes no cursor', async () => {
    stubGitHubIssues([]);
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    vi.stubEnv('GITHUB_ENTERPRISE_URL', 'https://ghes.example.com');
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const repo of ['ghes.example.com/acme/w', 'acme/w/extra', '/w', 'acme/', 'ac me/w']) {
        await expect(
          handleGitHub({
            hippoRoot,
            tenantId: 'default',
            args: ['backfill'],
            flags: { repo, since: '2026-01-01T00:00:00Z' },
          }),
        ).rejects.toMatchObject({ code: 2 });
      }
      expect(printed.mock.calls.map((c) => String(c[0])).join(' ')).toContain('hippo github backfill --repo');
    } finally {
      printed.mockRestore();
    }
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    const db = openHippoDb(hippoRoot);
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM github_cursors').get()).toEqual({ n: 0 });
    } finally {
      closeHippoDb(db);
    }
  });

  const contributorIssues = [
    { number: 2, title: 'arm64 crash', body: 'repro attached', user: { login: 'Alice', id: 1 } },
    { number: 3, title: 'arm64 hang', body: 'trace attached', user: { login: 'mallory', id: 9 } },
  ].map((issue) => ({
    ...issue,
    author_association: 'CONTRIBUTOR',
    updated_at: '2026-01-02T00:00:00Z',
  }));

  it('backfill keeps an outside-author issue live only when its user id is in GITHUB_TRUSTED_USER_IDS', async () => {
    stubGitHubIssues(contributorIssues);
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', '1');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleGitHub({ hippoRoot, tenantId: 'default', args: ['backfill'], flags: { repo: 'acme/widgets' } });

    const scopeOf = (suffix: string) =>
      loadAllEntries(hippoRoot, 'default').find((e) => e.artifactRef?.endsWith(suffix))?.scope;
    expect(scopeOf('/issue/2')).not.toMatch(/^quarantine:private:/);
    expect(scopeOf('/issue/3')).toMatch(/^quarantine:private:/);
  });

  it('backfill refuses a login in GITHUB_TRUSTED_USER_IDS before it fetches or writes anything', async () => {
    stubGitHubIssues(contributorIssues);
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', 'alice');

    await expect(
      handleGitHub({ hippoRoot, tenantId: 'default', args: ['backfill'], flags: { repo: 'acme/widgets' } }),
    ).rejects.toThrow(/GITHUB_TRUSTED_USER_IDS/);

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
  });

  it('dlq list on empty DLQ prints "no entries"', async () => {
    const r = await runCli(root, ['github', 'dlq', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no entries/);
  });

  it('dlq list with rows prints bucket and tenant', async () => {
    await parkInDlq(githubDlq, sqliteStore(hippoRoot), {
      tenantId: 'default',
      rawPayload: '{"x":1}',
      error: 'bad envelope',
      bucket: 'unhandled',
      eventName: 'issues',
    });
    const r = await runCli(root, ['github', 'dlq', 'list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/unhandled/);
    expect(r.stdout).toMatch(/default/);
    expect(r.stdout).toMatch(/bad envelope/);
  });

  it('dlq list reads the HIPPO_TENANT tenant, not default', async () => {
    for (const tenantId of ['default', 'acme']) {
      await parkInDlq(githubDlq, sqliteStore(hippoRoot), {
        tenantId,
        rawPayload: '{}',
        error: `err-${tenantId}`,
        bucket: 'unhandled',
      });
    }
    const r = await runCli(root, ['github', 'dlq', 'list'], {
      HIPPO_TENANT: 'acme',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/err-acme/);
    expect(r.stdout).not.toMatch(/err-default/);
  });

  it('dlq replay with invalid id exits 1 with not-found message', async () => {
    const r = await runCli(root, ['github', 'dlq', 'replay', '99999']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not[_ ]found|not found/i);
  });

  const SECRET = 'github-webhook-secret';
  const REPOSITORY = {
    full_name: 'acme/repo',
    private: false,
    owner: { login: 'acme' },
    name: 'repo',
  };
  const issueOpenedBody = JSON.stringify({
    action: 'opened',
    issue: {
      number: 42,
      title: 'Bug',
      body: 'broken',
      user: { login: 'alice', id: 1 },
      author_association: 'MEMBER',
    },
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
      comment: { id: 999, body: 'I can repro', user: { login: 'bob', id: 2 }, author_association: 'MEMBER' },
      repository: REPOSITORY,
      sender: { login: 'bob', id: 2 },
      installation: { id: 99 },
    });
  }

  function parkDelivery(
    eventName: string,
    body: string,
    secret: string = SECRET,
    bucket: 'unroutable' | 'parse_error' = 'unroutable',
  ): Promise<number> {
    return parkInDlq(githubDlq, sqliteStore(hippoRoot), {
      tenantId: 'default',
      rawPayload: body,
      error: 'unroutable: installation_id=99 repo=acme/repo',
      bucket,
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
    loadAllEntries(hippoRoot, 'default').filter((e) => e.kind === 'raw' && e.artifactRef === artifactRef);
  const retryCountOf = async (id: number) =>
    (await sqliteStore(hippoRoot).connectorEvents.deadLetters('github', 'default', { limit: 100 })).find(
      (row) => row.id === id,
    )?.retryCount;

  it('dlq replay re-ingests a parked delivery and counts the retry', async () => {
    const id = await parkDelivery('issues', issueOpenedBody);

    const r = await replay(id);

    expect(r.status).toBe(0);
    const raws = liveRaws('github://acme/repo/issue/42');
    expect(raws).toHaveLength(1);
    expect(r.stdout).toContain(`replay ok: status=replayed memory_id=${raws[0].id} retry_count=1`);
    expect(await retryCountOf(id)).toBe(1);
  });

  it.each(COMMENT_EVENTS)(
    'dlq replay of a parked %s deletion archives the comment instead of storing it again',
    async (eventName, parent, artifactRef) => {
      const created = await parkDelivery(eventName, commentBody(parent, 'created'));
      const deleted = await parkDelivery(eventName, commentBody(parent, 'deleted'));
      expect((await replay(created)).status).toBe(0);
      expect(liveRaws(artifactRef)).toHaveLength(1);

      const archived = await replay(deleted);
      expect(archived.status).toBe(0);
      expect(archived.stdout).toContain('replay ok: status=replayed memory_id=archived retry_count=1');
      expect(liveRaws(artifactRef)).toHaveLength(0);
      expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);

      const again = await replay(deleted);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('replay ok: status=replayed memory_id=(none) retry_count=2');
      expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
    },
  );

  const GHES_ENV = { GITHUB_ENTERPRISE_URL: 'https://ghes.example.com' };

  function withRepoUrl(body: string, htmlUrl: string | undefined): string {
    if (htmlUrl === undefined) return body;
    return body.replace('"repository":{', `"repository":{"html_url":"${htmlUrl}",`);
  }

  const replayWith = (id: number, extraEnv: Record<string, string>, ...flags: string[]) =>
    runCli(root, ['github', 'dlq', 'replay', String(id), ...flags], {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_WEBHOOK_SECRET_PREVIOUS: '',
      ...extraEnv,
    });

  it.each([
    ['issue_comment', { issue: { number: 42 } }, 'github://ghes.example.com/acme/repo/issue/42/comment/999'],
    [
      'pull_request_review_comment',
      { pull_request: { number: 7 } },
      'github://ghes.example.com/acme/repo/pull/7/review_comment/999',
    ],
  ] as const)(
    'A18. under GITHUB_ENTERPRISE_URL a replayed %s is stored under the host ref and its deletion archives it',
    async (eventName, parent, hostRef) => {
      const created = await parkDelivery(
        eventName,
        withRepoUrl(commentBody(parent, 'created'), 'https://ghes.example.com/acme/repo'),
      );
      const deleted = await parkDelivery(
        eventName,
        withRepoUrl(commentBody(parent, 'deleted'), 'https://ghes.example.com/acme/repo'),
      );

      expect((await replayWith(created, GHES_ENV)).status).toBe(0);
      expect(liveRaws(hostRef)).toHaveLength(1);

      expect((await replayWith(deleted, GHES_ENV)).status).toBe(0);
      expect(liveRaws(hostRef)).toHaveLength(0);
    },
  );

  it('A18b. with GITHUB_ENTERPRISE_BARE_REFS_HOST set, replaying a GHES deletion archives the bare twin', async () => {
    const [eventName, parent, bareRef] = COMMENT_EVENTS[0];
    const created = await parkDelivery(eventName, commentBody(parent, 'created'));
    expect((await replay(created)).status).toBe(0);
    expect(liveRaws(bareRef)).toHaveLength(1);

    const deleted = await parkDelivery(
      eventName,
      withRepoUrl(commentBody(parent, 'deleted'), 'https://ghes.example.com/acme/repo'),
    );
    const archived = await replayWith(deleted, { ...GHES_ENV, GITHUB_ENTERPRISE_BARE_REFS_HOST: 'ghes.example.com' });

    expect(archived.status).toBe(0);
    expect(archived.stdout).toContain('memory_id=archived');
    expect(liveRaws(bareRef)).toHaveLength(0);
  });

  it('A21. a github.com delivery parked as host_mismatch cannot replay under GHES, even with --force, and replays once the hosts agree', async () => {
    const parkedForHost = await parkInDlq(githubDlq, sqliteStore(hippoRoot), {
      tenantId: 'default',
      rawPayload: issueOpenedBody,
      error: hostMismatch(undefined, parseGitHubEnterpriseUrl('https://ghes.example.com'))!,
      bucket: 'host_mismatch',
      eventName: 'issues',
      deliveryId: 'delivery-host',
      signature: `sha256=${createHmac('sha256', SECRET).update(issueOpenedBody).digest('hex')}`,
      installationId: '99',
      repoFullName: 'acme/repo',
    });

    for (const flags of [[], ['--force']]) {
      const refused = await replayWith(parkedForHost, GHES_ENV, ...flags);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('status=unroutable');
      expect(refused.stderr).toContain('GITHUB_ENTERPRISE_URL names ghes.example.com');
      expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
    }

    const agreed = await replayWith(parkedForHost, { GITHUB_ENTERPRISE_URL: '' });
    expect(agreed.status).toBe(0);
    expect(liveRaws('github://acme/repo/issue/42')).toHaveLength(1);
  });

  it.each([
    ['a github.com payload', 'https://github.com/acme/repo', 'payload names github.com'],
    ['another GHES server', 'https://other.example.com/acme/repo', 'payload names other.example.com'],
    ['a payload with no repository URL', undefined, 'payload names no repository URL'],
  ] as const)(
    'A22. under GHES a parse_error row from %s is unroutable, even with --force',
    async (_label, htmlUrl, reason) => {
      const body = withRepoUrl(issueOpenedBody, htmlUrl);
      const id = await parkDelivery('issues', body, SECRET, 'parse_error');
      for (const flags of [[], ['--force']]) {
        const refused = await replayWith(id, GHES_ENV, ...flags);
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain('status=unroutable');
        expect(refused.stderr).toContain(reason);
        expect(refused.stderr).toContain('GITHUB_ENTERPRISE_URL names ghes.example.com');
        expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
      }
    },
  );

  it('A23. under GHES a parse_error row whose payload names the site host replays under the host ref', async () => {
    const body = withRepoUrl(issueOpenedBody, 'https://ghes.example.com/acme/repo');
    const id = await parkDelivery('issues', body, SECRET, 'parse_error');
    expect((await replayWith(id, GHES_ENV)).status).toBe(0);
    expect(liveRaws('github://ghes.example.com/acme/repo/issue/42')).toHaveLength(1);
  });

  it.each([
    ['github.com', 'https://github.com/acme/repo'],
    ['another server', 'https://other.example.com/acme/repo'],
    ['no URL', undefined],
  ] as const)('A24. with GITHUB_ENTERPRISE_URL unset a row naming %s still replays', async (_label, htmlUrl) => {
    const id = await parkDelivery('issues', withRepoUrl(issueOpenedBody, htmlUrl), SECRET, 'parse_error');
    expect((await replay(id)).status).toBe(0);
    expect(liveRaws('github://acme/repo/issue/42')).toHaveLength(1);
  });

  const contributorComment = (
    id: number,
    text: string,
    user: { login: string; id: number },
    repoUrl = 'https://github.com/acme/repo',
  ): string =>
    JSON.stringify({
      action: 'created',
      issue: { number: 42 },
      comment: { id, body: text, user, author_association: 'CONTRIBUTOR' },
      repository: { ...REPOSITORY, html_url: repoUrl },
      sender: user,
      installation: { id: 99 },
    });
  const replayWithTrusted = (id: number, trusted: string) =>
    runCli(root, ['github', 'dlq', 'replay', String(id)], {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_WEBHOOK_SECRET_PREVIOUS: '',
      GITHUB_TRUSTED_USER_IDS: trusted,
    });

  it('dlq replay reads GITHUB_TRUSTED_USER_IDS from the replaying shell', async () => {
    const bob = await parkDelivery(
      'issue_comment',
      contributorComment(3001, 'I can repro on arm64', { login: 'bob', id: 2 }),
    );
    const mallory = await parkDelivery(
      'issue_comment',
      contributorComment(3002, 'Same here on arm64', { login: 'mallory', id: 9 }),
    );

    expect((await replayWithTrusted(bob, '2')).status).toBe(0);
    expect((await replayWithTrusted(mallory, '2')).status).toBe(0);

    expect(liveRaws('github://acme/repo/issue/42/comment/3001')[0].scope).toBe('github:public:acme/repo');
    expect(liveRaws('github://acme/repo/issue/42/comment/3002')[0].scope).toMatch(/^quarantine:private:/);
  });

  it('A27. a replayed GHES payload from a listed id is held while the URL is unset', async () => {
    const id = await parkDelivery(
      'issue_comment',
      contributorComment(3005, 'I can repro on arm64', { login: 'bob', id: 2 }, 'https://ghes.example.com/acme/repo'),
    );

    expect((await replayWithTrusted(id, '2')).status).toBe(0);

    const rows = liveRaws('github://acme/repo/issue/42/comment/3005');
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toMatch(/^quarantine:private:/);
  });

  it('dlq replay refuses a login in GITHUB_TRUSTED_USER_IDS, stores nothing and leaves the retry count at 0', async () => {
    const id = await parkDelivery(
      'issue_comment',
      contributorComment(3003, 'I can repro on arm64', { login: 'bob', id: 2 }),
    );

    const r = await replayWithTrusted(id, 'alice');

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Error: GITHUB_TRUSTED_USER_IDS');
    expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
    expect(await retryCountOf(id)).toBe(0);
  });

  it('A26. under GHES a replayed outside-author comment is stored under the host ref and held', async () => {
    const id = await parkDelivery(
      'issue_comment',
      contributorComment(
        3004,
        'I can repro on arm64',
        { login: 'mallory', id: 9 },
        'https://ghes.example.com/acme/repo',
      ),
    );

    expect((await replayWith(id, { ...GHES_ENV, GITHUB_TRUSTED_USER_IDS: '2' })).status).toBe(0);

    const rows = liveRaws('github://ghes.example.com/acme/repo/issue/42/comment/3004');
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe('quarantine:private:github:public:ghes.example.com/acme/repo');
  });

  it('dlq replay stores nothing when the parked body does not match its event header', async () => {
    const id = await parkDelivery('issues', commentBody(COMMENT_EVENTS[0][1], 'created'));

    const r = await replay(id);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('replay ok: status=replayed memory_id=(none) retry_count=1');
    expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);
    expect(await retryCountOf(id)).toBe(1);
  });

  it('dlq replay refuses a row signed with another secret, and --force or the previous secret lets it through', async () => {
    const id = await parkDelivery('issues', issueOpenedBody, 'the-secret-before-rotation');

    const refused = await replay(id);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('replay failed: status=sig_fail retry_count=1 reason=signature did not verify');
    expect(loadAllEntries(hippoRoot, 'default')).toHaveLength(0);

    const rotated = await runCli(root, ['github', 'dlq', 'replay', String(id)], {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_WEBHOOK_SECRET_PREVIOUS: 'the-secret-before-rotation',
    });
    expect(rotated.status).toBe(0);
    expect(rotated.stdout).toContain('retry_count=2');
    expect(liveRaws('github://acme/repo/issue/42')).toHaveLength(1);

    const forced = await replay(id, '--force');
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('retry_count=3');
    expect(await retryCountOf(id)).toBe(3);
  });

  async function ingestedOfThreeIssues(repo: string, max: string | boolean): Promise<number> {
    stubGitHubIssues(
      [1, 2, 3].map((number) => ({
        number,
        title: `issue ${number}`,
        body: 'body text',
        user: { login: 'alice', id: 1 },
        author_association: 'MEMBER',
        updated_at: `2026-01-0${number}T00:00:00Z`,
      })),
    );
    const printed = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('GITHUB_TOKEN', 'fake-token');
    try {
      await handleGitHub({
        hippoRoot,
        tenantId: 'default',
        args: ['backfill'],
        flags: { repo, max },
      });
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
    const stored = loadAllEntries(hippoRoot, 'default').filter((e) =>
      e.artifactRef?.startsWith('github://acme/widgets/issue/'),
    );
    expect(stored).toHaveLength(expected);
  });
});

describe('parseParkedPayload', () => {
  it('throws a typed error naming the command and the first 200 characters', () => {
    const raw = `{bad${'x'.repeat(300)}`;
    let caught: unknown;
    try {
      parseParkedPayload(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitHubPayloadParseError);
    // SAFETY: the instanceof check above proved caught is a GitHubPayloadParseError, which extends Error.
    const message = (caught as Error).message;
    expect(message).toContain('hippo github dlq replay');
    expect(message).toContain(raw.slice(0, 200));
    expect(message).not.toContain(raw.slice(0, 201));
    expect(parseParkedPayload('{"a":1}')).toEqual({ a: 1 });
  });
});
