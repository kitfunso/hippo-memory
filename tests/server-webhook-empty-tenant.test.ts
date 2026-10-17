import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { serve, type ServerHandle } from '../src/server.js';
import { listDlq } from '../src/connectors/dlq.js';
import { githubDlq } from '../src/connectors/github/dlq.js';
import { slackDlq } from '../src/connectors/slack/dlq.js';
import { makeRoot } from './_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  beforeEach(async () => {
    root = makeRoot('empty-tenant');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', GH_SECRET);
    vi.stubEnv('SLACK_SIGNING_SECRET', SLACK_SECRET);
    vi.stubEnv('HIPPO_TENANT', envValue);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', undefined);
    vi.stubEnv('SLACK_SIGNING_SECRET', undefined);
    await handle.stop();
  });

  function tenantsOf(list: (tenant: string) => unknown[]) {
    return { def: list('default').length, empty: list('').length };
  }

  it('github unhandled-event DLQ row lands under tenant default', async () => {
    const res = await ghPost(handle.port, '{}', 'not-an-allowed-event');
    expect(res.status).toBe(200);
    expect(tenantsOf((t) => listDlq(githubDlq, root, { tenantId: t }))).toEqual({ def: 1, empty: 0 });
  });

  it('github invalid-JSON DLQ row lands under tenant default', async () => {
    await ghPost(handle.port, '{broken', 'issues');
    expect(tenantsOf((t) => listDlq(githubDlq, root, { tenantId: t }))).toEqual({ def: 1, empty: 0 });
  });

  it('slack non-envelope DLQ row lands under tenant default', async () => {
    await slackPost(handle.port, '{"foo":1}');
    expect(tenantsOf((t) => listDlq(slackDlq, root, { tenantId: t }))).toEqual({ def: 1, empty: 0 });
  });
});
