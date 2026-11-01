// A route or tool that opens hippo.db by its folder, past the store serve() was given, fails here. The served folder
// carries the other-store marker, so such an open throws and answers 501; the store keeps its rows in a folder of its own.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerHandle } from '../../src/server.js';
import { OTHER_STORE_MARKER } from '../../src/entry/store-kit.js';
import { OPTIONAL_GROUPS } from '../../src/base/ports/store-index.js';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import { TOOLS } from '../../src/surface/mcp/tools.js';
import { hippoHomeDir } from '../../src/host/agent-homes.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { V1_ROWS } from '../_helpers/v1-route-rows.js';
import { localFileRoutes } from '../_helpers/other-store-server.js';
import { FOLDER_GROUPS, portOnlyStore } from '../_helpers/port-only-store.js';
import { seedTwoTenants, type TwoTenantFixture } from '../_helpers/store-conformance.js';

const SECRETS = { slack: randomBytes(24).toString('hex'), github: randomBytes(24).toString('hex') };
const AS_OF = '?date=2099-01-01T00:00:00.000Z';

interface Sent {
  /** `$mem` stands for the newest memory id, `$key` for the newest key id. */
  readonly path?: string;
  readonly body?: JsonValue;
  /** A signed webhook body, sent as these exact bytes. */
  readonly raw?: string;
}

const slackBody = JSON.stringify({
  type: 'event_callback',
  team_id: 'T_ACME',
  event_id: 'Ev_1',
  event_time: 1_700_000_000,
  event: {
    type: 'message',
    channel: 'C1',
    channel_type: 'channel',
    user: 'U1',
    text: 'frozen until friday',
    ts: '1.1',
  },
});
const githubBody = JSON.stringify({
  action: 'created',
  installation: { id: 101 },
  repository: { full_name: 'acme/demo', private: false, owner: { login: 'acme' }, name: 'demo' },
  issue: { number: 1 },
  comment: { id: 9, body: 'I can reproduce this', user: { login: 'bob', id: 2 }, updated_at: '2026-02-28T09:00:00Z' },
});

function slackHeaders() {
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', SECRETS.slack).update(`v0:${ts}:${slackBody}`).digest('hex')}`;
  return { 'x-slack-request-timestamp': ts, 'x-slack-signature': signature };
}

function githubHeaders() {
  return {
    'x-hub-signature-256': `sha256=${createHmac('sha256', SECRETS.github).update(githubBody).digest('hex')}`,
    'x-github-event': 'issue_comment',
    'x-github-delivery': 'd-1',
  };
}

/** One request per /v1 row that its handler reads far enough to reach the store, sent in this order so each finds the
 * row the one before it left. */
const SENDS = {
  'POST /v1/memories': { body: { content: 'deploy the eu cluster on friday', kind: 'raw' } },
  'GET /v1/graph': {},
  'GET /v1/memories': { path: '/v1/memories?q=deploy' },
  'GET /v1/sessions/:id/assemble': { path: '/v1/sessions/s1/assemble' },
  'GET /v1/recall/drill/:id': { path: '/v1/recall/drill/$mem' },
  'POST /v1/memories/:id/supersede': {
    path: '/v1/memories/$mem/supersede',
    body: { content: 'deploy the eu cluster on monday' },
  },
  'POST /v1/memories/:id/archive': { path: '/v1/memories/$mem/archive', body: { reason: 'source deleted' } },
  'POST /v1/memories/:id/promote': { path: '/v1/memories/$mem/promote' },
  'POST /v1/outcome': { body: { good: true } },
  'GET /v1/context': { path: '/v1/context?q=deploy&project=p' },
  'POST /v1/vectors/nearest': {
    body: { vector: [0.1, 0.2, 0.3], spec: { tenantId: 'acme', includeSuperseded: false, origin: 'p' } },
  },
  'POST /v1/sleep': { body: { dry_run: true } },
  'POST /v1/auth/keys': { body: { label: 'probe' } },
  'GET /v1/auth/keys': {},
  'DELETE /v1/auth/keys/:keyId': { path: '/v1/auth/keys/$key' },
  'GET /v1/quarantine': {},
  'POST /v1/quarantine/:id/approve': { path: '/v1/quarantine/mem_000000000000/approve' },
  'POST /v1/quarantine/:id/reject': { path: '/v1/quarantine/mem_000000000000/reject' },
  'GET /v1/audit': {},
  'POST /v1/predictions': { body: { claim: 'the cutover takes two days', classTag: 'cutover', estimate: 2 } },
  'GET /v1/predictions': {},
  'GET /v1/predictions/stats': { path: '/v1/predictions/stats?class=cutover' },
  'POST /v1/predictions/:id/close': { path: '/v1/predictions/1/close', body: { state: 'closed', actual: 3 } },
  'GET /v1/predictions/:id': { path: '/v1/predictions/1' },
  'POST /v1/decisions': { body: { text: 'ship behind a flag', context: 'the last release broke login' } },
  'GET /v1/decisions': {},
  'POST /v1/decisions/:id/supersede': { body: { text: 'ship behind a flag, to 5% first' } },
  'POST /v1/decisions/:id/close': {},
  'GET /v1/decisions/:id': {},
  'POST /v1/incidents': { body: { text: 'login answered 500 for ten minutes' } },
  'GET /v1/incidents': {},
  'POST /v1/incidents/:id/resolve': { body: { resolutionText: 'rolled the flag back' } },
  'POST /v1/incidents/:id/close': {},
  'GET /v1/incidents/:id': {},
  'POST /v1/processes': { body: { processName: 'release', steps: ['tag', 'build', 'publish'] } },
  'GET /v1/processes': {},
  'POST /v1/processes/:id/supersede': { body: { steps: ['tag', 'build', 'smoke', 'publish'] } },
  'POST /v1/processes/:id/close': {},
  'GET /v1/processes/:id': {},
  'POST /v1/policies': {
    body: { policyName: 'RollbackPolicy', policyText: 'roll back within ten minutes', validFrom: '2026-01-01' },
  },
  'GET /v1/policies': {},
  'GET /v1/policies/asof': { path: `/v1/policies/asof${AS_OF}&name=RollbackPolicy` },
  'POST /v1/policies/:id/supersede': { body: { policyText: 'roll back within five minutes' } },
  'POST /v1/policies/:id/close': {},
  'GET /v1/policies/:id': {},
  'POST /v1/skills': { body: { skillName: 'rollback', instructions: 'revert the flag' } },
  'GET /v1/skills': {},
  'GET /v1/skills/export': {},
  'POST /v1/skills/:id/supersede': { body: { instructions: 'revert the flag, then page the owner' } },
  'POST /v1/skills/:id/close': {},
  'GET /v1/skills/:id': {},
  'POST /v1/project-briefs': { body: { repo: 'hippo', summary: 'agent memory, served over HTTP' } },
  'GET /v1/project-briefs': { path: '/v1/project-briefs?repo=hippo' },
  'POST /v1/project-briefs/refresh': { body: { repo: 'hippo' } },
  'POST /v1/project-briefs/:id/supersede': { body: { summary: 'agent memory, served from store workers' } },
  'POST /v1/project-briefs/:id/close': {},
  'GET /v1/project-briefs/:id': {},
  'POST /v1/customer-notes': { body: { customer: 'acme', note: 'renews in March' } },
  'GET /v1/customer-notes': { path: '/v1/customer-notes?customer=acme' },
  'POST /v1/customer-notes/:id/supersede': { body: { note: 'renews in April' } },
  'POST /v1/customer-notes/:id/close': {},
  'GET /v1/customer-notes/:id': {},
  'POST /v1/connectors/slack/events': { raw: slackBody },
  'POST /v1/connectors/github/events': { raw: githubBody },
  'DELETE /v1/memories/:id': { path: '/v1/memories/$mem' },
} satisfies Record<string, Sent>;

const TOOL_ARGS = {
  hippo_recall: { query: 'deploy' },
  hippo_assemble: { session_id: 's1' },
  hippo_drill: { summary_id: 'mem_000000000000' },
  hippo_remember: { text: 'the canary needs ten minutes of traffic' },
  hippo_outcome: { good: true },
  hippo_context: {},
  hippo_status: {},
  hippo_learn: {},
  hippo_conflicts: {},
  hippo_resolve: { conflict_id: 1, keep: 'mem_000000000000' },
  hippo_share: { id: 'mem_000000000000' },
  hippo_peers: {},
  hippo_predict_baserate: { class_tag: 'cutover' },
} satisfies Record<string, JsonValue>;

// The two routes and two tools that need hippo.db's local files answer 501 by design under any other store.
const LOCAL_FILE_TOOLS = new Set(['hippo_share', 'hippo_peers']);
// Every group but the folder ones, so a 501 here comes only from a direct open, not from a group the store lacks.
const FOLDER: ReadonlySet<string> = new Set(FOLDER_GROUPS);
const SERVED_GROUPS = OPTIONAL_GROUPS.filter((group) => !FOLDER.has(group));

describe('serve() under a store that is not hippo.db, on a folder that refuses hippo.db', () => {
  let fixture: TwoTenantFixture;
  let home: string;
  let served: string;
  let handle: ServerHandle;
  let homeBefore: boolean;
  const newest = { mem: 'mem_000000000000', key: 'hk_none', object: new Map<string, string>() };

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    vi.stubEnv('SLACK_SIGNING_SECRET', SECRETS.slack);
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRETS.github);
    fixture = seedTwoTenants();
    home = mkdtempSync(join(tmpdir(), 'hippo-no-direct-open-'));
    served = join(home, 'served');
    mkdirSync(served);
    writeFileSync(join(served, OTHER_STORE_MARKER), 'port-only\n');
    homeBefore = existsSync(join(hippoHomeDir(), 'hippo.db'));
    handle = await serve({ hippoRoot: served, port: 0, store: portOnlyStore(fixture.dir, SERVED_GROUPS) });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  async function send(key: string, sent: Sent): Promise<{ status: number; text: string }> {
    const [method = '', label = ''] = key.split(' ');
    const kind = label.split('/').slice(0, 3).join('/');
    const path = (sent.path ?? label.replace(':id', newest.object.get(kind) ?? '1'))
      .replace('$mem', newest.mem)
      .replace('$key', newest.key);
    const body = sent.raw ?? JSON.stringify(sent.body ?? {});
    const signed = path.endsWith('/slack/events')
      ? slackHeaders()
      : path.endsWith('/github/events')
        ? githubHeaders()
        : {};
    const res = await fetch(`${handle.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${fixture.tokens.adminA}`, 'content-type': 'application/json', ...signed },
      body: method === 'GET' ? undefined : body,
    });
    const text = await res.text();
    newest.mem = /"id":"(mem_[^"]+)"/.exec(text)?.[1] ?? newest.mem;
    newest.key = /"keyId":"(hk_[^"]+)"/.exec(text)?.[1] ?? newest.key;
    const objectId = /"id":(\d+)/.exec(text)?.[1];
    if (method === 'POST' && res.ok && objectId !== undefined) newest.object.set(kind, objectId);
    return { status: res.status, text };
  }

  it('names a request for every /v1 route', () => {
    expect(Object.keys(SENDS).sort()).toEqual(V1_ROWS.map(({ key }) => key).sort());
  });

  it('answers every /v1 route without opening hippo.db by its folder', async () => {
    const local = new Set(localFileRoutes().map((line) => line.split(' ')[1]?.replace('/1/', '/:id/')));
    const refused: string[] = [];
    for (const [key, sent] of Object.entries(SENDS)) {
      const { status, text } = await send(key, sent);
      if (status === 501 && text.includes(STORE_NOT_PORTED_MESSAGE) && !local.has(key.split(' ')[1])) {
        refused.push(key);
      }
    }
    expect(refused).toEqual([]);
  });

  it('names arguments for every MCP tool', () => {
    expect(Object.keys(TOOL_ARGS).sort()).toEqual(TOOLS.map(({ name }) => name).sort());
  });

  it('answers every MCP tool without opening hippo.db by its folder', async () => {
    const refused: string[] = [];
    for (const [name, args] of Object.entries(TOOL_ARGS)) {
      const res = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.tokens.adminA}`,
          'content-type': 'application/json',
          'x-hippo-project': 'p',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const text = await res.text();
      if (text.includes(STORE_NOT_PORTED_MESSAGE) && !LOCAL_FILE_TOOLS.has(name)) refused.push(name);
    }
    expect(refused).toEqual([]);
  });

  it('leaves no hippo.db in the served folder or the global store', () => {
    expect(readdirSync(served).sort()).toEqual(['.gitignore', OTHER_STORE_MARKER, 'server.key', 'server.pid'].sort());
    expect(existsSync(join(hippoHomeDir(), 'hippo.db'))).toBe(homeBefore);
  });
});
