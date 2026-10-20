// A captured Slack request stays signed for five minutes, so the route answers its second copy without acting on it.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { listDlq } from '../../src/connectors/dlq.js';
import { slackDlq } from '../../src/connectors/slack/dlq.js';
import { createReplayWindow } from '../../src/connectors/replay-window.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import type { JsonValue } from '../../src/util/json.js';

interface Reply {
  status: number;
  body: JsonValue;
}

const SECRET = 'replay-window-secret';
// Not an event envelope, so each accepted copy parks one DLQ row under the default tenant.
const BODY = '{"type":"not_an_envelope"}';

let root: string;
let handle: ServerHandle;

beforeEach(async () => {
  root = makeRoot('slack-replay');
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRET);
  handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await handle.stop();
  vi.unstubAllEnvs();
});

async function post(ts: string): Promise<Reply> {
  const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${BODY}`).digest('hex')}`;
  const res = await fetch(`${handle.url}/v1/connectors/slack/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': signature },
    body: BODY,
  });
  return { status: res.status, body: await res.json() };
}

describe('POST /v1/connectors/slack/events replay', () => {
  it('answers a second copy of a signed request as a duplicate and parks nothing more', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await post(ts)).toEqual({ status: 200, body: { ok: true, status: 'dlq' } });
    expect(await post(ts)).toEqual({ status: 200, body: { ok: true, status: 'duplicate' } });
    expect(await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' })).toHaveLength(1);
  });

  it('refuses the second copy after the server restarts, since the hold lives in the store', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(await post(ts)).toEqual({ status: 200, body: { ok: true, status: 'dlq' } });
    await handle.stop();
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
    expect(await post(ts)).toEqual({ status: 200, body: { ok: true, status: 'duplicate' } });
    expect(await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' })).toHaveLength(1);
  });

  it('frees the hold when routing fails, so the retry is tried again and not answered as a duplicate', async () => {
    const db = openHippoDb(root);
    try {
      db.exec('DROP TABLE slack_dlq');
    } finally {
      closeHippoDb(db);
    }
    const ts = String(Math.floor(Date.now() / 1000));
    const first = await post(ts);
    const second = await post(ts);

    expect(first.body).not.toEqual({ ok: true, status: 'duplicate' });
    expect(second.body).not.toEqual({ ok: true, status: 'duplicate' });
    expect(second.status).toBe(first.status);
  });

  it('takes the same body under a new timestamp, since Slack signs each send afresh', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await post(String(now - 1))).toEqual({ status: 200, body: { ok: true, status: 'dlq' } });
    expect(await post(String(now))).toEqual({ status: 200, body: { ok: true, status: 'dlq' } });
    expect(await listDlq(slackDlq, sqliteStore(root), { tenantId: 'default' })).toHaveLength(2);
  });
});

describe('createReplayWindow', () => {
  it('refuses a key inside the window and takes it again once the window has passed', () => {
    const w = createReplayWindow(1000, 10);
    expect([w.claim('a', 0), w.claim('a', 999), w.claim('a', 1000)]).toEqual([true, false, true]);
  });

  it('takes a released key again at once', () => {
    const w = createReplayWindow(1000, 10);
    w.claim('a', 0);
    w.release('a');
    expect(w.claim('a', 1)).toBe(true);
  });

  it('drops the oldest claim at the cap', () => {
    const w = createReplayWindow(1000, 2);
    w.claim('a', 0);
    w.claim('b', 1);
    w.claim('c', 2);
    expect([w.claim('b', 3), w.claim('a', 3)]).toEqual([false, true]);
  });
});
