// Total remembered, hippo.db's store-wide counter, moves on every path that lands a remembered row:
// hippo serve, a replayed dead letter and hippo_learn over MCP, each through countRemembered.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { parkInDlq } from '../../src/api/dead-letters.js';
import { rememberUntrusted } from '../../src/api/index.js';
import type { GitRunner } from '../../src/base/ports/git.js';
import { loadConfig } from '../../src/host/config-file.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { replaySlackDlqEntry, slackDlq } from '../../src/surface/connectors/slack/dlq.js';
import { runLearnTool } from '../../src/surface/mcp/memory-tools.js';
import { mcpApiContext } from '../../src/surface/mcp/protocol.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';
import { execOn, keyFor, newRoot, post, start, undoAll } from '../_helpers/store-worker-server.js';

afterEach(undoAll);

const SECRET = 'remembered-count-secret';
const LESSONS = [
  'fix: the retry loop dropped the last queued webhook delivery',
  'fix: the cache key left out the tenant id on reads',
];

const remembered = async (root: string): Promise<number> =>
  Number((await sqliteStore(root).hippoDb.reports.stats()).total_remembered);

/** A dead letter whose payload is a signed Slack message for a routed team, as a replay finds it. */
async function parkedMessage(root: string): Promise<{ id: number; ts: string }> {
  execOn(
    root,
    `INSERT INTO slack_workspaces (team_id, tenant_id, added_at) VALUES ('TCOUNT', 'default', '2026-01-01T00:00:00.000Z')`,
  );
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: 'TCOUNT',
    event_id: 'EvCount1',
    event_time: Number(ts),
    event: {
      type: 'message',
      channel: 'C1',
      channel_type: 'channel',
      user: 'U1',
      text: 'count-me',
      ts: `${ts}.000100`,
    },
  });
  const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
  const id = await parkInDlq({ store: sqliteStore(root) }, slackDlq, {
    tenantId: 'default',
    teamId: 'TCOUNT',
    rawPayload: body,
    error: 'historical parse_error',
    bucket: 'parse_error',
    signature,
    slackTimestamp: ts,
  });
  return { id, ts };
}

describe('Total remembered', () => {
  it('counts a REST remember and an MCP hippo_remember under hippo serve, one each', async () => {
    const root = newRoot('remembered-serve');
    const server = await start(root);
    const { plaintext } = keyFor(root, 'default');
    const rest = await post(
      server,
      '/v1/memories',
      { content: 'the eu cluster deploys on friday', force: true },
      plaintext,
    );
    expect(rest.status).toBe(200);
    const params = { name: 'hippo_remember', arguments: { text: 'the us cluster deploys on monday' } };
    const mcp = await post(server, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params }, plaintext);
    expect(await mcp.text()).toContain('Remembered [');

    expect(await remembered(root)).toBe(2);
  });

  it('counts the row a replayed dead letter lands, and nothing for an event already logged', async () => {
    const root = newRoot('remembered-dlq');
    const { id, ts } = await parkedMessage(root);
    const ports = { tenantId: 'default', store: sqliteStore(root), config: loadConfig(root), infra: testInfra() };
    const replay = await replaySlackDlqEntry(ports, id, { signingSecret: SECRET, now: Number(ts), skewSeconds: 60 });
    expect(replay).toMatchObject({ ok: true, status: 'ingested' });
    expect(await remembered(root)).toBe(1);

    const ctx = apiCtx(root, 'default', { subject: 'connector:slack', role: 'admin' });
    const twice = { content: 'a message delivered twice', event: { connector: 'slack', eventId: 'EvTwice' } } as const;
    expect((await rememberUntrusted(ctx, twice)).duplicate).toBeUndefined();
    expect((await rememberUntrusted(ctx, twice)).duplicate).toBeDefined();
    expect(await remembered(root)).toBe(2);
  });

  it('counts each lesson hippo_learn over MCP lands', async () => {
    const root = newRoot('remembered-learn');
    const git: GitRunner = {
      run: (args) => ({ ok: true, stdout: args[0] === 'rev-parse' ? 'true\n' : LESSONS.join('\n') }),
    };
    const infra = testInfra();
    const store = sqliteStore(root);
    const config = loadConfig(root);
    const ctx = mcpContext({
      hippoRoot: root,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      stdio: true,
      store,
      config,
      infra: { ...infra, machine: { ...infra.machine, git, cwd: '/injected/folder' } },
    });
    const call = { args: { days: 30 }, ctx, hippoRoot: root, config, tenantId: 'default', store };
    const text = await runLearnTool({ ...call, api: { ...mcpApiContext(ctx), store } });
    expect(text).toMatch(/^Git learn: 2 new/);

    expect(await remembered(root)).toBe(2);
  });
});
