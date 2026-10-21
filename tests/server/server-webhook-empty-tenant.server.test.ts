import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { ServerHandle } from '../../src/server.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { makeRoot } from '../_helpers/make-root.js';
import { needsHippoDb, serve } from '../_helpers/store-switch.js';

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
    await handle.stop();
  });

  function tenantsOf(list: (tenant: string) => unknown[]) {
    return { def: list('default').length, empty: list('').length };
  }

  it.skipIf(needsHippoDb('db'))('github unhandled-event DLQ row lands under tenant default', async () => {
    const res = await ghPost(handle.port, '{}', 'not-an-allowed-event');
    expect(res.status).toBe(200);
    expect(tenantsOf((t) => sqliteSyncStore(handlesOf(root)).connectorEvents.deadLetters('github', t, 100))).toEqual({
      def: 1,
      empty: 0,
    });
  });

  it.skipIf(needsHippoDb('db'))('github invalid-JSON DLQ row lands under tenant default', async () => {
    await ghPost(handle.port, '{broken', 'issues');
    expect(tenantsOf((t) => sqliteSyncStore(handlesOf(root)).connectorEvents.deadLetters('github', t, 100))).toEqual({
      def: 1,
      empty: 0,
    });
  });

  it.skipIf(needsHippoDb('db'))('slack non-envelope DLQ row lands under tenant default', async () => {
    await slackPost(handle.port, '{"foo":1}');
    expect(tenantsOf((t) => sqliteSyncStore(handlesOf(root)).connectorEvents.deadLetters('slack', t, 100))).toEqual({
      def: 1,
      empty: 0,
    });
  });
});
