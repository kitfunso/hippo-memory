import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { listDlq as listGitHubDlq } from '../src/connectors/github/dlq.js';
import { listDlq as listSlackDlq } from '../src/connectors/slack/dlq.js';

const GH_SECRET = 'gh-secret';
const SLACK_SECRET = 'slack-secret';

function ghPost(port: number, body: string, event: string): Promise<Response> {
  const sig = `sha256=${createHmac('sha256', GH_SECRET).update(body).digest('hex')}`;
  return fetch(`http://127.0.0.1:${port}/v1/connectors/github/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sig,
      'x-github-event': event,
      'x-github-delivery': 'd-1',
    },
    body,
  });
}

function slackPost(port: number, body: string): Promise<Response> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  return fetch(`http://127.0.0.1:${port}/v1/connectors/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

describe.each(['', '   '])('webhook DLQ rows with HIPPO_TENANT=%j', (envValue) => {
  let root: string;
  let handle: ServerHandle;
  let savedTenant: string | undefined;

  beforeEach(async () => {
    savedTenant = process.env.HIPPO_TENANT;
    root = mkdtempSync(join(tmpdir(), 'hippo-empty-tenant-'));
    initStore(root);
    process.env.GITHUB_WEBHOOK_SECRET = GH_SECRET;
    process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
    process.env.HIPPO_TENANT = envValue;
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    if (savedTenant === undefined) delete process.env.HIPPO_TENANT;
    else process.env.HIPPO_TENANT = savedTenant;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function tenantsOf(list: (db: ReturnType<typeof openHippoDb>, tenant: string) => unknown[]) {
    const db = openHippoDb(root);
    try {
      return { def: list(db, 'default').length, empty: list(db, '').length };
    } finally {
      closeHippoDb(db);
    }
  }

  it('github unhandled-event DLQ row lands under tenant default', async () => {
    const res = await ghPost(handle.port, '{}', 'not-an-allowed-event');
    expect(res.status).toBe(200);
    expect(tenantsOf((db, t) => listGitHubDlq(db, { tenantId: t }))).toEqual({ def: 1, empty: 0 });
  });

  it('github invalid-JSON DLQ row lands under tenant default', async () => {
    await ghPost(handle.port, '{broken', 'issues');
    expect(tenantsOf((db, t) => listGitHubDlq(db, { tenantId: t }))).toEqual({ def: 1, empty: 0 });
  });

  it('slack non-envelope DLQ row lands under tenant default', async () => {
    await slackPost(handle.port, '{"foo":1}');
    expect(tenantsOf((db, t) => listSlackDlq(db, { tenantId: t }))).toEqual({ def: 1, empty: 0 });
  });
});
