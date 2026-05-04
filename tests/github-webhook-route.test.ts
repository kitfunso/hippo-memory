import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore, loadAllEntries } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const SECRET = 'github-webhook-secret';

function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function postWebhook(
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/connectors/github/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

function defaultHeaders(body: string, eventName: string, deliveryId: string): Record<string, string> {
  return {
    'x-hub-signature-256': sign(body),
    'x-github-event': eventName,
    'x-github-delivery': deliveryId,
  };
}

interface IssueBodyOpts {
  action?: string;
  number?: number;
  installationId?: number | null;
  repoFullName?: string;
}

function issueBody(opts: IssueBodyOpts = {}): string {
  const obj: Record<string, unknown> = {
    action: opts.action ?? 'opened',
    issue: {
      number: opts.number ?? 42,
      title: 'Bug',
      body: 'broken',
      user: { login: 'alice', id: 1 },
    },
    repository: {
      full_name: opts.repoFullName ?? 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'alice', id: 1 },
  };
  if (opts.installationId !== null) {
    obj.installation = { id: opts.installationId ?? 99 };
  }
  return JSON.stringify(obj);
}

function issueCommentBody(action: 'created' | 'edited' | 'deleted' = 'created'): string {
  return JSON.stringify({
    action,
    issue: { number: 42 },
    comment: {
      id: 999,
      body: 'I can repro',
      user: { login: 'bob', id: 2 },
    },
    repository: {
      full_name: 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'bob', id: 2 },
    installation: { id: 99 },
  });
}

function pullRequestBody(): string {
  return JSON.stringify({
    action: 'opened',
    pull_request: {
      number: 7,
      title: 'Fix',
      body: 'patches the bug',
      user: { login: 'carol', id: 3 },
    },
    repository: {
      full_name: 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'carol', id: 3 },
    installation: { id: 99 },
  });
}

function prReviewCommentBody(action: 'created' | 'deleted' = 'created'): string {
  return JSON.stringify({
    action,
    pull_request: { number: 7 },
    comment: {
      id: 12345,
      body: 'nit',
      user: { login: 'dave', id: 4 },
    },
    repository: {
      full_name: 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'dave', id: 4 },
    installation: { id: 99 },
  });
}

describe('POST /v1/connectors/github/events', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-gh-route-'));
    initStore(root);
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_WEBHOOK_SECRET_PREVIOUS;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('1. valid signature + issues.opened → 200, memory ingested', async () => {
    const body = issueBody();
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-1'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; status: string; memoryId: string };
    expect(json.ok).toBe(true);
    expect(json.status).toBe('ingested');

    const entries = loadAllEntries(root);
    const ghRow = entries.find((e) => e.tags.includes('source:github') && e.kind === 'raw');
    expect(ghRow).toBeDefined();
    expect(ghRow!.artifact_ref).toBe('github://acme/repo/issue/42');
  });

  it('2. valid signature + issue_comment.created → 200, memory ingested', async () => {
    const body = issueCommentBody('created');
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issue_comment', 'd-2'));
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root);
    const ghRow = entries.find(
      (e) => e.kind === 'raw' && e.artifact_ref === 'github://acme/repo/issue/42/comment/999',
    );
    expect(ghRow).toBeDefined();
  });

  it('3. valid signature + pull_request.opened → 200, memory ingested', async () => {
    const body = pullRequestBody();
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'pull_request', 'd-3'));
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root);
    const ghRow = entries.find(
      (e) => e.kind === 'raw' && e.artifact_ref === 'github://acme/repo/pull/7',
    );
    expect(ghRow).toBeDefined();
  });

  it('4. valid signature + pull_request_review_comment.created → 200, memory ingested', async () => {
    const body = prReviewCommentBody('created');
    const res = await postWebhook(
      handle.port,
      body,
      defaultHeaders(body, 'pull_request_review_comment', 'd-4'),
    );
    expect(res.status).toBe(200);
    const entries = loadAllEntries(root);
    const ghRow = entries.find(
      (e) =>
        e.kind === 'raw' &&
        e.artifact_ref === 'github://acme/repo/pull/7/review_comment/12345',
    );
    expect(ghRow).toBeDefined();
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
    delete process.env.GITHUB_WEBHOOK_SECRET;
    try {
      const body = '{}';
      const res = await postWebhook(handle.port, body, {
        'x-hub-signature-256': 'sha256=anything',
        'x-github-event': 'ping',
        'x-github-delivery': 'd-7',
      });
      expect(res.status).toBe(404);
    } finally {
      process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    }
  });

  it('8. ping event → 200 with {pong: true}, no memory', async () => {
    const body = JSON.stringify({ zen: 'Speak like a human.', hook_id: 1 });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'ping', 'd-8'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pong: boolean };
    expect(json.pong).toBe(true);
    const entries = loadAllEntries(root);
    expect(entries.filter((e) => e.tags.includes('source:github')).length).toBe(0);
  });

  it('9. issue_comment.deleted → archives previously-ingested comment', async () => {
    // First, ingest a comment.
    const createBody = issueCommentBody('created');
    const createRes = await postWebhook(
      handle.port,
      createBody,
      defaultHeaders(createBody, 'issue_comment', 'd-9a'),
    );
    expect(createRes.status).toBe(200);
    const beforeRaws = loadAllEntries(root).filter(
      (e) => e.kind === 'raw' && e.artifact_ref === 'github://acme/repo/issue/42/comment/999',
    );
    expect(beforeRaws.length).toBe(1);

    // Now delete it.
    const delBody = issueCommentBody('deleted');
    const delRes = await postWebhook(
      handle.port,
      delBody,
      defaultHeaders(delBody, 'issue_comment', 'd-9b'),
    );
    expect(delRes.status).toBe(200);
    const json = (await delRes.json()) as { ok: boolean; status: string; archivedCount: number };
    expect(json.status).toBe('archived');
    expect(json.archivedCount).toBe(1);

    const afterRaws = loadAllEntries(root).filter(
      (e) => e.kind === 'raw' && e.artifact_ref === 'github://acme/repo/issue/42/comment/999',
    );
    expect(afterRaws.length).toBe(0);
  });

  it('10. unknown installation in multi-tenant install → DLQ unroutable + 200', async () => {
    // Seed github_installations with a different installation_id (multi-tenant).
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('77', 'tenant-other', new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }

    const body = issueBody({ installationId: 12345 }); // unknown
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-10'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('dlq');

    const db2 = openHippoDb(root);
    try {
      const row = db2
        .prepare(`SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`)
        .get() as { bucket: string };
      expect(row.bucket).toBe('unroutable');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('11. PAT-mode webhook with no repo mapping → DLQ unroutable + 200', async () => {
    // Seed github_installations non-empty so PAT-mode falls through to repo lookup.
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('77', 'tenant-other', new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }

    const body = issueBody({ installationId: null, repoFullName: 'unknown/repo' });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-11'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('dlq');

    const db2 = openHippoDb(root);
    try {
      const row = db2
        .prepare(`SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`)
        .get() as { bucket: string };
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
      db.prepare(
        `INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('77', 'tenant-other', new Date().toISOString());
      db.prepare(
        `INSERT INTO github_repositories (repo_full_name, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('acme/repo', 'tenant-a', new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }

    const body = issueBody({ installationId: null });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-12'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('ingested');

    const db2 = openHippoDb(root);
    try {
      const row = db2
        .prepare(
          `SELECT tenant_id FROM memories WHERE artifact_ref = 'github://acme/repo/issue/42' AND kind = 'raw'`,
        )
        .get() as { tenant_id: string };
      expect(row.tenant_id).toBe('tenant-a');
    } finally {
      closeHippoDb(db2);
    }
  });

  it('13. JSON parse error with valid signature → DLQ parse_error + 200', async () => {
    const body = 'not-json';
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-13'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('dlq');

    const db = openHippoDb(root);
    try {
      const row = db
        .prepare(`SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`)
        .get() as { bucket: string };
      expect(row.bucket).toBe('parse_error');
    } finally {
      closeHippoDb(db);
    }
  });

  it('14. replay with same body but different delivery UUID → dedup via idempotency_key', async () => {
    const body = issueBody();
    const res1 = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-14a'));
    expect(res1.status).toBe(200);
    const j1 = (await res1.json()) as { status: string };
    expect(j1.status).toBe('ingested');

    const res2 = await postWebhook(handle.port, body, defaultHeaders(body, 'issues', 'd-14b-DIFFERENT-UUID'));
    expect(res2.status).toBe(200);
    const j2 = (await res2.json()) as { status: string };
    expect(['duplicate', 'skipped_duplicate']).toContain(j2.status);

    const rows = loadAllEntries(root).filter(
      (e) => e.kind === 'raw' && e.artifact_ref === 'github://acme/repo/issue/42',
    );
    expect(rows.length).toBe(1);
  });

  it('15. unhandled event type with valid signature → DLQ unhandled + 200', async () => {
    const body = JSON.stringify({
      action: 'created',
      discussion: { number: 1 },
      repository: { full_name: 'acme/repo', owner: { login: 'acme' }, name: 'repo' },
    });
    const res = await postWebhook(handle.port, body, defaultHeaders(body, 'discussion', 'd-15'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe('dlq');

    const db = openHippoDb(root);
    try {
      const row = db
        .prepare(`SELECT bucket FROM github_dlq ORDER BY id DESC LIMIT 1`)
        .get() as { bucket: string };
      expect(row.bucket).toBe('unhandled');
    } finally {
      closeHippoDb(db);
    }
  });
});
