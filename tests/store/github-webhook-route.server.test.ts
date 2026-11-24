import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { jsonAs } from '../_helpers/http-objects-server.js';
import {
  SECRET,
  defaultHeaders,
  issueBody,
  issueCommentBody,
  postWebhook,
  prReviewCommentBody,
  pullRequestBody,
  queryOne,
  sign,
} from '../_helpers/github-webhook-route.js';
import { githubTrustedUserIds } from '../../src/surface/connectors/github/webhook.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /v1/connectors/github/events', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('gh-route');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  it('1. valid signature + issues.opened → 200, memory ingested', async () => {
    const body = issueBody();
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-1'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ ok: boolean; status: string; memoryId: string }>(res);
    expect(json.ok).toBe(true);
    expect(json.status).toBe('ingested');

    const entries = loadAllEntries(root, 'default');
    const ghRow = entries.find((e) => e.tags.includes('source:github') && e.kind === 'raw');
    expect(ghRow?.artifactRef).toBe('github://acme/repo/issue/42');
  });

  it('2. valid signature + issue_comment.created → 200, memory ingested', async () => {
    const body = issueCommentBody('created');
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issue_comment', 'd-2'));
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root, 'default');
    const ghRow = entries.find((e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/issue/42/comment/999');
    expect(ghRow?.artifactRef).toBe('github://acme/repo/issue/42/comment/999');
  });

  it('3. valid signature + pull_request.opened → 200, memory ingested', async () => {
    const body = pullRequestBody();
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'pull_request', 'd-3'));
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root, 'default');
    const ghRow = entries.find((e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/pull/7');
    expect(ghRow?.artifactRef).toBe('github://acme/repo/pull/7');
  });

  it('4. valid signature + pull_request_review_comment.created → 200, memory ingested', async () => {
    const body = prReviewCommentBody('created');
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'pull_request_review_comment', 'd-4'));
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root, 'default');
    const ghRow = entries.find(
      (e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/pull/7/review_comment/12345',
    );
    expect(ghRow?.artifactRef).toBe('github://acme/repo/pull/7/review_comment/12345');
  });

  it('5. bad signature → 401', async () => {
    const body = issueBody();
    const res = await postWebhook(handle.port, body, {
      'x-hub-signature-256': 'sha256=deadbeef',
      'x-github-event': 'issues',
      'x-github-delivery': 'd-5',
    });
    expect(res.status).toBe(401);
  });

  it('6. missing x-hub-signature-256 header → 401', async () => {
    const body = issueBody();
    const res = await postWebhook(handle.port, body, {
      'x-github-event': 'issues',
      'x-github-delivery': 'd-6',
    });
    expect(res.status).toBe(401);
  });

  it('7. missing GITHUB_WEBHOOK_SECRET env → 404', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', undefined);
    try {
      const body = '{}';
      const res = await postWebhook(handle.port, body, {
        'x-hub-signature-256': 'sha256=anything',
        'x-github-event': 'ping',
        'x-github-delivery': 'd-7',
      });
      expect(res.status).toBe(404);
    } finally {
      vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    }
  });

  it('8. ping event → 200 with {pong: true}, no memory', async () => {
    const body = JSON.stringify({ zen: 'Speak like a human.', hook_id: 1 });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'ping', 'd-8'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ pong: boolean }>(res);
    expect(json.pong).toBe(true);
    const entries = loadAllEntries(root, 'default');
    expect(entries.filter((e) => e.tags.includes('source:github')).length).toBe(0);
  });

  it('9. issue_comment.deleted → archives previously-ingested comment', async () => {
    // First, ingest a comment.
    const createBody = issueCommentBody('created');
    const createRes = await postWebhook(handle.port, createBody, defaultHeaders(createBody, 'issue_comment', 'd-9a'));
    expect(createRes.status).toBe(200);
    const beforeRaws = loadAllEntries(root, 'default').filter(
      (e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/issue/42/comment/999',
    );
    expect(beforeRaws.length).toBe(1);

    // Now delete it.
    const delBody = issueCommentBody('deleted');
    const delRes = await postWebhook(handle.port, delBody, defaultHeaders(delBody, 'issue_comment', 'd-9b'));
    expect(delRes.status).toBe(200);
    const json = await jsonAs<{ ok: boolean; status: string; archivedCount: number }>(delRes);
    expect(json.status).toBe('archived');
    expect(json.archivedCount).toBe(1);

    const afterRaws = loadAllEntries(root, 'default').filter(
      (e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/issue/42/comment/999',
    );
    expect(afterRaws.length).toBe(0);
  });

  it('10. unknown installation in multi-tenant install → DLQ unroutable + 200', async () => {
    // Seed github_installations with a different installation_id (multi-tenant).
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        '77',
        'tenant-other',
        new Date().toISOString(),
      );
    } finally {
      closeHippoDb(db);
    }

    const body = issueBody({ installationId: 12345 }); // unknown
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-10'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ status: string }>(res);
    expect(json.status).toBe('dlq');

    const db2 = openHippoDb(root);
    try {
      const row = queryOne<{ bucket: string }>(db2, `SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`);
      expect(row.bucket).toBe('unroutable');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('11. PAT-mode webhook with no repo mapping → DLQ unroutable + 200', async () => {
    // Seed github_installations non-empty so PAT-mode falls through to repo lookup.
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        '77',
        'tenant-other',
        new Date().toISOString(),
      );
    } finally {
      closeHippoDb(db);
    }

    const body = issueBody({ installationId: null, repoFullName: 'unknown/repo' });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-11'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ status: string }>(res);
    expect(json.status).toBe('dlq');

    const db2 = openHippoDb(root);
    try {
      const row = queryOne<{ bucket: string }>(db2, `SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`);
      expect(row.bucket).toBe('unroutable');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('12. PAT-mode webhook with repo mapping → ingested under mapped tenant', async () => {
    // Seed both routing tables: installations is non-empty (forces multi-tenant
    // mode) and repositories has a mapping for the inbound repo.
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        '77',
        'tenant-other',
        new Date().toISOString(),
      );
      db.prepare(`INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        'acme/repo',
        'tenant-a',
        new Date().toISOString(),
      );
    } finally {
      closeHippoDb(db);
    }

    const body = issueBody({ installationId: null });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-12'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ status: string }>(res);
    expect(json.status).toBe('ingested');

    const db2 = openHippoDb(root);
    try {
      const row = queryOne<{ tenant_id: string }>(
        db2,
        `SELECT tenant_id FROM memories WHERE artifact_ref = 'github://acme/repo/issue/42' AND kind = 'raw'`,
      );
      expect(row.tenant_id).toBe('tenant-a');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('13. JSON parse error with valid signature → DLQ parse_error + 200', async () => {
    const body = 'not-json';
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-13'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ status: string }>(res);
    expect(json.status).toBe('dlq');

    const db = openHippoDb(root);
    try {
      const row = queryOne<{ bucket: string }>(db, `SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`);
      expect(row.bucket).toBe('parse_error');
    } finally {
      closeHippoDb(db);
    }
  });

  it('14. the same signed body resent under a fresh delivery id is refused with 409 and adds no row', async () => {
    const body = issueBody();
    const res1 = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-14a'));
    expect(res1.status).toBe(200);
    expect((await jsonAs<{ status: string }>(res1)).status).toBe('ingested');

    const res2 = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-14b-DIFFERENT-UUID'));
    expect({ status: res2.status, body: await res2.json() }).toEqual({
      status: 409,
      body: { error: 'duplicate X-GitHub-Delivery' },
    });

    const rows = loadAllEntries(root, 'default').filter(
      (e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/issue/42',
    );
    expect(rows.length).toBe(1);
  });

  it('14b. a signed body is accepted once however many delivery ids carry it; a different signed body passes', async () => {
    const issueRows = () =>
      loadAllEntries(root, 'default').filter(
        (e) => e.kind === 'raw' && e.artifactRef?.startsWith('github://acme/repo/issue/'),
      );
    const first = issueBody({ number: 50 });
    expect((await postWebhook(handle.port, first, defaultHeaders(first, 'issues', 'd-replay'))).status).toBe(200);

    for (const id of ['d-replay', 'd-replay-2']) {
      const replay = await postWebhook(handle.port, first, defaultHeaders(first, 'issues', id));
      expect({ status: replay.status, body: await replay.json() }).toEqual({
        status: 409,
        body: { error: 'duplicate X-GitHub-Delivery' },
      });
    }
    expect(issueRows().map((e) => e.artifactRef)).toEqual(['github://acme/repo/issue/50']);

    const other = issueBody({ number: 51 });
    const fresh = await postWebhook(handle.port, other, defaultHeaders(other, 'issues', 'd-replay'));
    expect({ status: fresh.status, status_field: (await jsonAs<{ status: string }>(fresh)).status }).toEqual({
      status: 200,
      status_field: 'ingested',
    });
    expect(
      issueRows()
        .map((e) => e.artifactRef)
        .sort(),
    ).toEqual(['github://acme/repo/issue/50', 'github://acme/repo/issue/51']);
  });

  it('14c. holds a signature past any time the event log could drop its idempotency key, which it never does', async () => {
    const body = issueBody({ number: 52 });
    expect((await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-14c'))).status).toBe(200);
    const db = openHippoDb(root);
    try {
      const hold = queryOne<{ value: string }>(
        db,
        `SELECT value FROM meta WHERE key = 'delivery_hold:github:${sign(body)}'`,
      );
      expect(Number(hold.value) - Date.now()).toBeGreaterThan(99 * 365 * 24 * 60 * 60 * 1000);
    } finally {
      closeHippoDb(db);
    }
  });

  it('14d.the same delivery replayed after a restart is refused with 409, since the hold lives in the store, and adds no rows', async () => {
    const issueRows = () =>
      loadAllEntries(root, 'default').filter(
        (e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/issue/53',
      );
    const body = issueBody({ number: 53 });
    expect(
      (
        await jsonAs<{ status: string }>(
          await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-restart')),
        )
      ).status,
    ).toBe('ingested');
    await handle.stop();
    // A fresh module graph is a fresh process's memory; only the store's hold can still know d-restart.
    vi.resetModules();
    const restarted: typeof import('../../src/server.js') = await import('../../src/server.js');
    handle = await restarted.serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
    const replay = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-restart'));
    expect({ status: replay.status, body: await replay.json() }).toEqual({
      status: 409,
      body: { error: 'duplicate X-GitHub-Delivery' },
    });
    expect(issueRows()).toHaveLength(1);
  });

  it('14c. a bad signature never claims a delivery id, so the signed delivery under that id still lands', async () => {
    const body = issueBody({ number: 52 });
    const forged = await postWebhook(handle.port, body, {
      ...defaultHeaders(body, 'issues', 'd-forged-first'),
      'x-hub-signature-256': 'sha256=deadbeef',
    });
    expect(forged.status).toBe(401);
    expect((await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-forged-first'))).status).toBe(200);
  });

  it('15. unhandled event type with valid signature → DLQ unhandled + 200', async () => {
    const body = JSON.stringify({
      action: 'created',
      discussion: { number: 1 },
      repository: { full_name: 'acme/repo', owner: { login: 'acme' }, name: 'repo' },
    });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'discussion', 'd-15'));
    expect(res.status).toBe(200);
    const json = await jsonAs<{ status: string }>(res);
    expect(json.status).toBe('dlq');

    const db = openHippoDb(root);
    try {
      const row = queryOne<{ bucket: string }>(db, `SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`);
      expect(row.bucket).toBe('unhandled');
    } finally {
      closeHippoDb(db);
    }
  });

  it('16. issues.deleted → parked for manual review, the ingested issue stays', async () => {
    const openBody = issueBody();
    const openRes = await postWebhook(handle.port, openBody, defaultHeaders(openBody, 'issues', 'd-16a'));
    expect(openRes.status).toBe(200);

    const delBody = issueBody({ action: 'deleted' });
    const delRes = await postWebhook(handle.port, delBody, defaultHeaders(delBody, 'issues', 'd-16b'));
    expect(delRes.status).toBe(200);
    expect(await jsonAs<{ ok: boolean; status: string }>(delRes)).toEqual({ ok: true, status: 'dlq' });

    const db = openHippoDb(root);
    try {
      const row = queryOne<Record<string, string>>(
        db,
        `SELECT bucket, error, event_name, delivery_id, tenant_id, installation_id, repo_full_name, raw_payload
           FROM github_dlq ORDER BY id DESC LIMIT 1`,
      );
      expect({ ...row }).toEqual({
        bucket: 'unhandled',
        error: 'issues.deleted requires manual review',
        event_name: 'issues',
        delivery_id: 'd-16b',
        tenant_id: 'default',
        installation_id: '99',
        repo_full_name: 'acme/repo',
        raw_payload: delBody,
      });
    } finally {
      closeHippoDb(db);
    }
    const issueRows = loadAllEntries(root, 'default').filter(
      (e) => e.kind === 'raw' && e.artifactRef === 'github://acme/repo/issue/42',
    );
    expect(issueRows.length).toBe(1);
  });

  it('17. pull_request_review_comment.deleted → archives the previously-ingested review comment', async () => {
    const artifactRef = 'github://acme/repo/pull/7/review_comment/12345';
    const liveRaws = () =>
      loadAllEntries(root, 'default').filter((e) => e.kind === 'raw' && e.artifactRef === artifactRef);
    const createBody = prReviewCommentBody('created');
    const createRes = await postWebhook(
      handle.port,
      createBody,
      defaultHeaders(createBody, 'pull_request_review_comment', 'd-17a'),
    );
    expect(createRes.status).toBe(200);
    expect(liveRaws().length).toBe(1);

    const delBody = prReviewCommentBody('deleted');
    const delRes = await postWebhook(
      handle.port,
      delBody,
      defaultHeaders(delBody, 'pull_request_review_comment', 'd-17b'),
    );
    expect(delRes.status).toBe(200);
    expect(await jsonAs<{ ok: boolean; status: string; archivedCount: number }>(delRes)).toEqual({
      ok: true,
      status: 'archived',
      archivedCount: 1,
    });
    expect(liveRaws().length).toBe(0);

    // Nothing was parked: the delete was handled, not left for an operator.
    const db = openHippoDb(root);
    try {
      expect(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM github_dlq`).n).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('18. an X-GitHub-Enterprise-Host header with GITHUB_ENTERPRISE_URL unset still ingests under github.com keys', async () => {
    const body = issueBody();
    const res = await postWebhook(handle.port, body, {
      ...defaultHeaders(body, 'issues', 'd-18'),
      'x-github-enterprise-host': 'ghes.example.com',
    });
    expect(await jsonAs<{ status: string }>(res)).toMatchObject({ status: 'ingested' });

    const row = loadAllEntries(root, 'default').find((e) => e.tags.includes('source:github') && e.kind === 'raw');
    expect(row?.artifactRef).toBe('github://acme/repo/issue/42');
    expect(row?.tags).toContain('repo:acme/repo');
    const db = openHippoDb(root);
    try {
      expect(queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM github_dlq`).n).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });
  it('19. a comment from a listed user id is kept live; once the id leaves the list the same author is held', async () => {
    const commentBody = (id: number, text: string): string =>
      JSON.stringify({
        action: 'created',
        issue: { number: 42 },
        comment: {
          id,
          body: text,
          user: { login: 'erin', id: 5 },
          author_association: 'CONTRIBUTOR',
        },
        repository: {
          full_name: 'acme/repo',
          html_url: 'https://github.com/acme/repo',
          private: false,
          owner: { login: 'acme' },
          name: 'repo',
        },
        sender: { login: 'erin', id: 5 },
        installation: { id: 99 },
      });
    const scopeOf = (commentId: number) =>
      loadAllEntries(root, 'default').find(
        (e) => e.artifactRef === `github://acme/repo/issue/42/comment/${String(commentId)}`,
      )?.scope;

    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', ' 5 , ,6 ');
    const first = commentBody(2001, 'I can repro on arm64');
    expect((await postWebhook(handle.port, first, defaultHeaders(first, 'issue_comment', 'd-18a'))).status).toBe(200);
    expect(scopeOf(2001)).toBe('github:public:acme/repo');

    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', '6');
    const second = commentBody(2002, 'Still repros on arm64');
    expect((await postWebhook(handle.port, second, defaultHeaders(second, 'issue_comment', 'd-18b'))).status).toBe(200);
    expect(scopeOf(2002)).toBe('quarantine:private:github:public:acme/repo');
  });
});

describe('githubTrustedUserIds', () => {
  it('reads numeric ids, trims them and drops blank entries; unset is an empty list', () => {
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', ' 5, ,1234567 ');
    expect([...githubTrustedUserIds()].sort((x, y) => x - y)).toEqual([5, 1234567]);

    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', undefined);
    expect(githubTrustedUserIds().size).toBe(0);
  });

  it('refuses a login, or a login:id pair, and names the command that gets an id', () => {
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', '5,alice');
    expect(() => githubTrustedUserIds()).toThrow(/entry 2/);
    expect(() => githubTrustedUserIds()).toThrow(/gh api users\/<login> --jq \.id/);

    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', 'alice:5');
    expect(() => githubTrustedUserIds()).toThrow(/GITHUB_TRUSTED_USER_IDS/);
  });

  it('never prints an entry, such as a token pasted into the wrong variable', () => {
    const pasted = `ghp_${'x'.repeat(36)}`;
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', `5,${pasted}`);

    expect(pasted).toHaveLength(40);
    let message = '';
    try {
      githubTrustedUserIds();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('not numeric GitHub user ids: entry 2;');
    expect(message).not.toContain(pasted);
  });

  it('counts entry positions before blank entries are dropped and never prints a hex secret', () => {
    const secret = '0123456789abcdef0123456789abcdef';
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', `5,,${secret}`);

    let message = '';
    try {
      githubTrustedUserIds();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('entry 3');
    expect(message).not.toContain(secret);
  });

  it('keeps hippo serve from starting on a bad entry', async () => {
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', 'alice');

    const started = await serve({
      hippoRoot: makeRoot('trusted-ids-bad'),
      host: '127.0.0.1',
      port: 0,
    }).then(
      async (handle) => {
        await handle.stop();
        return true;
      },
      (err: Error) => err,
    );

    expect(started).toBeInstanceOf(Error);
    expect(String(started)).toMatch(/GITHUB_TRUSTED_USER_IDS/);
  });
});
