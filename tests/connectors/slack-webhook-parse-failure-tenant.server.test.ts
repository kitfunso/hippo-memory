import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { serve, type ServerHandle } from '../../src/server.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SECRET = 'shhh';

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

describe('POST /v1/connectors/slack/events parse-failure tenant attribution', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('slack-parsefail');
    vi.stubEnv('SLACK_SIGNING_SECRET', SECRET);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  function rowsByTenant(tenant: string) {
    return sqliteStore(root).connectorEvents.deadLetters('slack', tenant, {
      limit: 100,
    });
  }

  it('parse failure with known team_id routes DLQ to the mapped tenant (not HIPPO_TENANT)', async () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        'T_ACME',
        'acme',
        new Date().toISOString(),
      );
    } finally {
      closeHippoDb(db);
    }
    vi.stubEnv('HIPPO_TENANT', 'deployment-default');

    const badBody = '{"team_id":"T_ACME","event":{broken-json-here';
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, badBody),
      },
      body: badBody,
    });
    expect([200, 400]).toContain(res.status);

    expect(await rowsByTenant('acme')).toHaveLength(1);
    expect(await rowsByTenant('deployment-default')).toHaveLength(0);
    const row = (await rowsByTenant('acme'))[0]!;
    expect(row.error).toBe('invalid JSON');
    expect(row.bucket).toBe('parse_error');
    expect(row.teamId).toBe('T_ACME');
  });

  it('parse failure with unknown team_id (workspace not registered) lands as __unroutable__', async () => {
    const db = openHippoDb(root);
    try {
      db.prepare(`INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
        'T_OTHER',
        'other-tenant',
        new Date().toISOString(),
      );
    } finally {
      closeHippoDb(db);
    }
    vi.stubEnv('HIPPO_TENANT', 'deployment-default');

    const badBody = '{"team_id":"T_UNKNOWN","event":{not-json';
    const ts = String(Math.floor(Date.now() / 1000));
    await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, badBody),
      },
      body: badBody,
    });

    expect(await rowsByTenant('__unroutable__')).toHaveLength(1);
    expect(await rowsByTenant('deployment-default')).toHaveLength(0);
    expect(await rowsByTenant('other-tenant')).toHaveLength(0);
  });

  it('parse failure with un-extractable team_id (totally garbage body) lands as __unroutable__', async () => {
    vi.stubEnv('HIPPO_TENANT', 'deployment-default');

    const badBody = 'totally garbage body no team id here at all';
    const ts = String(Math.floor(Date.now() / 1000));
    await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, badBody),
      },
      body: badBody,
    });

    expect(await rowsByTenant('__unroutable__')).toHaveLength(1);
    expect(await rowsByTenant('deployment-default')).toHaveLength(0);
  });

  it('single-workspace install (slack_workspaces empty): parse failure still routes via env fallback', async () => {
    vi.stubEnv('HIPPO_TENANT', 'single-deployment');

    const badBody = '{"team_id":"T_SOMETHING","event":{bad-json';
    const ts = String(Math.floor(Date.now() / 1000));
    await fetch(`http://127.0.0.1:${handle.port}/v1/connectors/slack/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sign(ts, badBody),
      },
      body: badBody,
    });

    expect(await rowsByTenant('single-deployment')).toHaveLength(1);
  });
});
