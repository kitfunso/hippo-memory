/**
 * B4 v1.12.6: parse-failure tenant attribution.
 *
 * Pre-v1.12.6 the JSON.parse-catch path in POST /v1/connectors/slack/events
 * wrote DLQ rows with `tenantId = HIPPO_TENANT` regardless of the
 * originating workspace. On a multi-workspace install (slack_workspaces
 * non-empty), a parse failure from workspace A would silently leak into
 * the deployment's tenant DLQ instead of workspace A's tenant DLQ.
 *
 * Fix: the parse-failure path now resolves tenant via the regex-extracted
 * teamIdFromRaw + the same slack_workspaces table the happy path uses.
 * Unknown / un-extractable team → null → '__unroutable__' sentinel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { listDlq } from '../src/connectors/slack/dlq.js';

const SECRET = 'shhh';

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

describe('POST /v1/connectors/slack/events parse-failure tenant attribution (B4 v1.12.6)', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-slack-parsefail-'));
    initStore(root);
    process.env.SLACK_SIGNING_SECRET = SECRET;
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.HIPPO_TENANT;
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function rowsByTenant(tenant: string) {
    const db = openHippoDb(root);
    try {
      return listDlq(db, { tenantId: tenant });
    } finally {
      closeHippoDb(db);
    }
  }

  it('parse failure with known team_id routes DLQ to the mapped tenant (not HIPPO_TENANT)', async () => {
    // Multi-workspace install: register team_id T_ACME → tenant 'acme'.
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('T_ACME', 'acme', new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }
    process.env.HIPPO_TENANT = 'deployment-default';

    // Send an invalid-JSON body that still carries a recognisable team_id.
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
    // 4xx is fine here (Slack route returns 200 + ok:false on parse fail; the
    // important assertion is the DLQ row landing).
    expect([200, 400]).toContain(res.status);

    // DLQ row should be tenant='acme', NOT tenant='deployment-default'.
    expect(rowsByTenant('acme')).toHaveLength(1);
    expect(rowsByTenant('deployment-default')).toHaveLength(0);
    const row = rowsByTenant('acme')[0]!;
    expect(row.error).toBe('invalid JSON');
    expect(row.bucket).toBe('parse_error');
    expect(row.teamId).toBe('T_ACME');
  });

  it('parse failure with unknown team_id (workspace not registered) lands as __unroutable__', async () => {
    // Multi-workspace install with at least one registration → unknown team
    // means fail-closed (resolveTenantForTeam returns null).
    const db = openHippoDb(root);
    try {
      db.prepare(
        `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`,
      ).run('T_OTHER', 'other-tenant', new Date().toISOString());
    } finally {
      closeHippoDb(db);
    }
    process.env.HIPPO_TENANT = 'deployment-default';

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

    expect(rowsByTenant('__unroutable__')).toHaveLength(1);
    expect(rowsByTenant('deployment-default')).toHaveLength(0);
    expect(rowsByTenant('other-tenant')).toHaveLength(0);
  });

  it('parse failure with un-extractable team_id (totally garbage body) lands as __unroutable__', async () => {
    process.env.HIPPO_TENANT = 'deployment-default';

    // No team_id substring at all → teamIdFromRaw is null.
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

    expect(rowsByTenant('__unroutable__')).toHaveLength(1);
    // Critical: NOT the deployment tenant.
    expect(rowsByTenant('deployment-default')).toHaveLength(0);
  });

  it('single-workspace install (slack_workspaces empty): parse failure still routes via env fallback', async () => {
    // resolveTenantForTeam's empty-workspaces branch returns HIPPO_TENANT.
    // This preserves single-workspace install ergonomics (no DLQ landing in
    // __unroutable__ when there's no multi-tenant routing intent).
    process.env.HIPPO_TENANT = 'single-deployment';

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

    // Empty slack_workspaces → resolveTenantForTeam returns HIPPO_TENANT.
    expect(rowsByTenant('single-deployment')).toHaveLength(1);
  });
});
