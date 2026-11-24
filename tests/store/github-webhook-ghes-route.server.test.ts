import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { jsonAs } from '../_helpers/http-objects-server.js';
import { log } from '../../src/base/util/log.js';
import { hostMismatch, mismatchSender, parseGitHubEnterpriseUrl } from '../../src/surface/connectors/github/site.js';
import {
  SECRET,
  defaultHeaders,
  issueBody,
  issueCommentBody,
  postWebhook,
  prReviewCommentBody,
} from '../_helpers/github-webhook-route.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /v1/connectors/github/events on GHES', () => {
  const GHES_URL = 'https://ghes.example.com';
  const GHES_SITE = parseGitHubEnterpriseUrl(GHES_URL);
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('gh-route-ghes');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('GITHUB_ENTERPRISE_URL', GHES_URL);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  const ghesHeaders = (body: string, eventName: string, deliveryId: string) => ({
    ...defaultHeaders(body, eventName, deliveryId),
    'x-github-enterprise-host': 'ghes.example.com',
  });

  const dlqRows = () => {
    const db = openHippoDb(root);
    try {
      return db.prepare(`SELECT bucket, tenant_id, error FROM github_dlq ORDER BY id`).all() as Array<{
        bucket: string;
        tenant_id: string;
        error: string;
      }>;
    } finally {
      closeHippoDb(db);
    }
  };

  const liveRaws = (artifactRef: string) =>
    loadAllEntries(root, 'default').filter((e) => e.kind === 'raw' && e.artifactRef === artifactRef);

  it('G1. issues.opened is stored under the host ref, repo tag and scope', async () => {
    const body = issueBody();
    const res = await postWebhook(handle.port, body, ghesHeaders(body, 'issues', 'g1'));
    expect(await jsonAs<{ status: string }>(res)).toMatchObject({ status: 'ingested' });

    const row = loadAllEntries(root, 'default').find((e) => e.tags.includes('source:github') && e.kind === 'raw');
    expect(row?.artifactRef).toBe('github://ghes.example.com/acme/repo/issue/42');
    expect(row?.tags).toContain('repo:ghes.example.com/acme/repo');
    expect(row?.scope).toBe('github:public:ghes.example.com/acme/repo');
  });

  it.each([
    {
      eventName: 'issue_comment',
      make: (a: 'created' | 'deleted') => issueCommentBody(a),
      ref: 'github://ghes.example.com/acme/repo/issue/42/comment/999',
    },
    {
      eventName: 'pull_request_review_comment',
      make: (a: 'created' | 'deleted') => prReviewCommentBody(a),
      ref: 'github://ghes.example.com/acme/repo/pull/7/review_comment/12345',
    },
  ])('G2. a deleted $eventName archives the row stored under the host ref', async ({ eventName, make, ref }) => {
    const created = make('created');
    await postWebhook(handle.port, created, ghesHeaders(created, eventName, `g2a-${eventName}`));
    expect(liveRaws(ref)).toHaveLength(1);

    const deleted = make('deleted');
    const res = await postWebhook(handle.port, deleted, ghesHeaders(deleted, eventName, `g2b-${eventName}`));
    expect(await jsonAs<{ status: string; archivedCount: number }>(res)).toMatchObject({
      status: 'archived',
      archivedCount: 1,
    });
    expect(liveRaws(ref)).toHaveLength(0);
  });

  it.each([{ header: 'other.example.com' }, { header: undefined }])(
    'G3. a delivery from $header is parked as host_mismatch, with a warning',
    async ({ header }) => {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
      try {
        const body = issueBody();
        const deliveryId = `g3-${header ?? 'none'}`;
        const signed = defaultHeaders(body, 'issues', deliveryId);
        const headers = header === undefined ? signed : { ...signed, 'x-github-enterprise-host': header };
        const res = await postWebhook(handle.port, body, headers);
        expect(res.status).toBe(200);
        expect(await jsonAs<{ ok: boolean; status: string }>(res)).toEqual({ ok: true, status: 'dlq' });

        expect(dlqRows()).toEqual([
          { bucket: 'host_mismatch', tenant_id: 'default', error: hostMismatch(header, GHES_SITE) },
        ]);
        expect(loadAllEntries(root, 'default').filter((e) => e.tags.includes('source:github'))).toHaveLength(0);
        const parked = warn.mock.calls.filter(([m]) => String(m).includes('host_mismatch'));
        expect(parked).toHaveLength(1);
        expect(String(parked[0]?.[0])).toContain(deliveryId);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('G4. a delivery whose header names the site but whose payload names github.com parks as host_mismatch', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const body = issueBody().replace('"repository":{', '"repository":{"html_url":"https://github.com/acme/repo",');
      const res = await postWebhook(handle.port, body, ghesHeaders(body, 'issues', 'g4'));
      expect(await jsonAs<{ ok: boolean; status: string }>(res)).toEqual({ ok: true, status: 'dlq' });
      const rows = dlqRows();
      expect(rows.map((r) => r.bucket)).toEqual(['host_mismatch']);
      expect(rows[0]?.error).toContain('ghes.example.com');
      expect(mismatchSender(rows[0]?.error ?? '')).toEqual({ sent: 'ghes.example.com' });
      expect(loadAllEntries(root, 'default').filter((e) => e.tags.includes('source:github'))).toHaveLength(0);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('host_mismatch'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('G4b. a payload naming the site host is ingested', async () => {
    const body = issueBody().replace(
      '"repository":{',
      '"repository":{"html_url":"https://ghes.example.com/acme/repo",',
    );
    const res = await postWebhook(handle.port, body, ghesHeaders(body, 'issues', 'g4b'));
    expect(await jsonAs<{ status: string }>(res)).toMatchObject({ status: 'ingested' });
  });

  it('G5. an unmapped github.com delivery parks as host_mismatch, not unroutable, when a routing row exists', async () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        'globex/other',
        'default',
        '2026-01-01T00:00:00.000Z',
      );
    } finally {
      closeHippoDb(db);
    }
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      const body = issueBody({ installationId: null });
      const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'g5'));
      expect(await jsonAs<{ status: string }>(res)).toMatchObject({ status: 'dlq' });
    } finally {
      warn.mockRestore();
    }
    expect(dlqRows().map((r) => r.bucket)).toEqual(['host_mismatch']);
  });

  it('G6. an outside author is held and still stored under the host ref and repo tag', async () => {
    const body = issueBody().replace('"author_association":"MEMBER"', '"author_association":"NONE"');
    expect(body).toContain('"author_association":"NONE"');
    const res = await postWebhook(handle.port, body, ghesHeaders(body, 'issues', 'g6'));
    expect(await jsonAs<{ status: string }>(res)).toMatchObject({ status: 'ingested' });

    const row = liveRaws('github://ghes.example.com/acme/repo/issue/42')[0];
    expect(row?.tags).toContain('repo:ghes.example.com/acme/repo');
    expect(row?.scope).toBe('quarantine:private:github:public:ghes.example.com/acme/repo');
  });
});

describe('POST /v1/connectors/github/events with a bad GITHUB_ENTERPRISE_URL', () => {
  it('G4. serve refuses to start, naming the setting', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('GITHUB_ENTERPRISE_URL', 'https://ghe');
    await expect(serve({ hippoRoot: makeRoot('gh-ghes-boot'), host: '127.0.0.1', port: 0 })).rejects.toThrow(
      /GITHUB_ENTERPRISE_URL/,
    );
  });
});

describe('POST /v1/connectors/github/events with GITHUB_ENTERPRISE_BARE_REFS_HOST set', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('gh-route-bare');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  const ghesHeaders = (body: string, eventName: string, deliveryId: string) => ({
    ...defaultHeaders(body, eventName, deliveryId),
    'x-github-enterprise-host': 'ghes.example.com',
  });

  it('B1. a signed GHES deletion archives the comment an earlier unset-URL delivery stored bare', async () => {
    const created = issueCommentBody('created');
    await postWebhook(handle.port, created, ghesHeaders(created, 'issue_comment', 'b1-created'));
    const bareRef = 'github://acme/repo/issue/42/comment/999';
    const live = () => loadAllEntries(root, 'default').filter((e) => e.kind === 'raw' && e.artifactRef === bareRef);
    expect(live()).toHaveLength(1);

    vi.stubEnv('GITHUB_ENTERPRISE_URL', 'https://ghes.example.com');
    vi.stubEnv('GITHUB_ENTERPRISE_BARE_REFS_HOST', 'ghes.example.com');
    const deleted = issueCommentBody('deleted');
    const res = await postWebhook(handle.port, deleted, ghesHeaders(deleted, 'issue_comment', 'b1-deleted'));
    expect(await jsonAs<{ status: string; archivedCount: number }>(res)).toMatchObject({
      status: 'archived',
      archivedCount: 1,
    });
    expect(live()).toHaveLength(0);
  });
});

describe('GITHUB_TRUSTED_USER_IDS applies only to items from the configured server', () => {
  let handle: ServerHandle | undefined;
  let root: string;

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  const start = async (enterpriseUrl: string | undefined) => {
    root = makeRoot('gh-route-trusted-site');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('GITHUB_TRUSTED_USER_IDS', '5');
    if (enterpriseUrl !== undefined) vi.stubEnv('GITHUB_ENTERPRISE_URL', enterpriseUrl);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  };

  // Author id 5, association NONE: only the trusted-id list can keep this issue live.
  const outsideIssue = (htmlUrl: string): string =>
    issueBody()
      .replace('"user":{"login":"alice","id":1}', '"user":{"login":"erin","id":5}')
      .replace('"author_association":"MEMBER"', '"author_association":"NONE"')
      .replace('"repository":{', `"repository":{"html_url":"${htmlUrl}",`);

  const scopeOf = () => loadAllEntries(root, 'default').find((e) => e.kind === 'raw')?.scope;

  const send = async (body: string, deliveryId: string, ghesHost?: string) => {
    const headers = defaultHeaders(body, 'issues', deliveryId);
    const res = await postWebhook(
      handle?.port ?? 0,
      body,
      ghesHost === undefined ? headers : { ...headers, 'x-github-enterprise-host': ghesHost },
    );
    expect(await jsonAs<{ status: string }>(res)).toMatchObject({ status: 'ingested' });
  };

  it('T1. with the setting unset, a GHES delivery from a listed id is held', async () => {
    await start(undefined);
    await send(outsideIssue('https://ghes.example.com/acme/repo'), 't1', 'ghes.example.com');
    expect(scopeOf()).toMatch(/^quarantine:private:/);
  });

  it('T2. with the setting unset, a github.com delivery from a listed id stays live', async () => {
    await start(undefined);
    await send(outsideIssue('https://github.com/acme/repo'), 't2');
    expect(scopeOf()).toBe('github:public:acme/repo');
  });

  it('T3. with the setting on the GHES host, a GHES delivery from a listed id stays live', async () => {
    await start('https://ghes.example.com');
    await send(outsideIssue('https://ghes.example.com/acme/repo'), 't3', 'ghes.example.com');
    expect(scopeOf()).toBe('github:public:ghes.example.com/acme/repo');
  });
});
