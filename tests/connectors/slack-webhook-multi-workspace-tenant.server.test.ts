import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { serve, type ServerHandle } from '../../src/server.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const SECRET = 'shhh-test-secret';

function sign(ts: string, body: string): string {
  return `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function registerWorkspace(root: string, teamId: string, tenantId: string): void {
  const db = openHippoDb(root);
  try {
    db.prepare(`INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES (?, ?, ?)`).run(
      teamId,
      tenantId,
      new Date().toISOString(),
    );
  } finally {
    closeHippoDb(db);
  }
}

async function postEvent(port: number, body: string): Promise<{ status: number; body: unknown }> {
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await fetch(`http://127.0.0.1:${port}/v1/connectors/slack/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sign(ts, body),
    },
    body,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = await res.text();
  }
  return { status: res.status, body: parsed };
}

function makeMessageEvent(opts: {
  teamId: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  eventId: string;
}): string {
  return JSON.stringify({
    type: 'event_callback',
    team_id: opts.teamId,
    event_id: opts.eventId,
    event_time: Math.floor(Date.now() / 1000),
    event: {
      type: 'message',
      channel: opts.channel,
      channel_type: 'channel',
      user: opts.user,
      text: opts.text,
      ts: opts.ts,
    },
  });
}

describe('POST /v1/connectors/slack/events multi-workspace tenant routing', () => {
  let root: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    root = makeRoot('multi-ws');
    vi.stubEnv('SLACK_SIGNING_SECRET', SECRET);
    handle = await serve({ hippoRoot: root, host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
  });

  function entriesByTenant(tenantId: string) {
    return loadEveryTenantEntries(root)
      .filter((e) => e.tags.includes('source:slack'))
      .filter((e) => e.tenantId === tenantId);
  }

  it('registered team routes the ingested memory to the mapped tenant', async () => {
    vi.stubEnv('HIPPO_TENANT', 'deployment-fallback');
    registerWorkspace(root, 'T_ACME', 'acme');

    const res = await postEvent(
      handle.port,
      makeMessageEvent({
        teamId: 'T_ACME',
        channel: 'C1',
        user: 'U_alice',
        text: 'multi-workspace alpha sentinel',
        ts: '1716800000.000100',
        eventId: 'Ev_acme_001',
      }),
    );
    expect(res.status).toBe(200);

    const acmeEntries = entriesByTenant('acme');
    expect(acmeEntries).toHaveLength(1);
    expect(acmeEntries[0]!.content).toContain('multi-workspace alpha sentinel');
    expect(acmeEntries[0]!.kind).toBe('raw');

    expect(entriesByTenant('deployment-fallback')).toHaveLength(0);
  });

  it('two workspaces isolate: team-A messages NEVER produce tenant-B memories', async () => {
    registerWorkspace(root, 'T_ACME', 'acme');
    registerWorkspace(root, 'T_GLOBEX', 'globex');

    await postEvent(
      handle.port,
      makeMessageEvent({
        teamId: 'T_ACME',
        channel: 'C1',
        user: 'U_alice',
        text: 'acme private payload bravo',
        ts: '1716800100.000100',
        eventId: 'Ev_acme_002',
      }),
    );
    await postEvent(
      handle.port,
      makeMessageEvent({
        teamId: 'T_GLOBEX',
        channel: 'C2',
        user: 'U_bob',
        text: 'globex private payload charlie',
        ts: '1716800200.000100',
        eventId: 'Ev_globex_001',
      }),
    );

    const acme = entriesByTenant('acme');
    const globex = entriesByTenant('globex');
    expect(acme).toHaveLength(1);
    expect(globex).toHaveLength(1);
    expect(acme[0]!.content).toContain('acme private payload bravo');
    expect(globex[0]!.content).toContain('globex private payload charlie');

    expect(acme.find((e) => e.content?.includes('globex'))).toBeUndefined();
    expect(globex.find((e) => e.content?.includes('acme'))).toBeUndefined();
  });

  it('foreign team (not in slack_workspaces, non-empty table) does NOT leak into HIPPO_TENANT', async () => {
    vi.stubEnv('HIPPO_TENANT', 'deployment-fallback');
    registerWorkspace(root, 'T_KNOWN', 'known-tenant');

    const res = await postEvent(
      handle.port,
      makeMessageEvent({
        teamId: 'T_FOREIGN',
        channel: 'C1',
        user: 'U_unknown',
        text: 'foreign leak attempt delta',
        ts: '1716800300.000100',
        eventId: 'Ev_foreign_001',
      }),
    );
    expect(res.status).toBe(200);

    expect(entriesByTenant('known-tenant')).toHaveLength(0);
    expect(entriesByTenant('deployment-fallback')).toHaveLength(0);
    expect(loadEveryTenantEntries(root).filter((e) => e.tags.includes('source:slack'))).toHaveLength(0);
  });

  it('single-workspace install (empty slack_workspaces) routes via HIPPO_TENANT', async () => {
    vi.stubEnv('HIPPO_TENANT', 'single-deployment');

    const res = await postEvent(
      handle.port,
      makeMessageEvent({
        teamId: 'T_ANY',
        channel: 'C1',
        user: 'U_alice',
        text: 'single workspace echo',
        ts: '1716800400.000100',
        eventId: 'Ev_single_001',
      }),
    );
    expect(res.status).toBe(200);

    const entries = entriesByTenant('single-deployment');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toContain('single workspace echo');
  });
});
