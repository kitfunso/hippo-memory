// Drill, outcome, context, promote, sleep, both webhooks, POST /mcp, GET /mcp/stream, /health and /ready answer from
// store workers as they do on the in-process store, and fail when a handler opens hippo.db on the server thread.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serve, type ServerHandle } from '../../src/server.js';
import type { HippoStore, StoreGroups } from '../../src/store/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { workerSqliteStore } from '../../src/store/sqlite/worker-store.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { log } from '../../src/base/util/log.js';
import { type Callers, leftBehind, type MovedReadsSeed, seedMovedReads } from '../_helpers/moved-reads-seed.js';
import { CLEARED_ENV, FAKE_NOW, freshStore, TENANT } from '../_helpers/recall-golden-seed.js';
import {
  auditRows,
  get,
  mirrorFiles,
  onDb,
  post,
  postText,
  scrub,
  seen,
  undoAll,
} from '../_helpers/store-worker-server.js';

type InProcess = HippoStore & StoreGroups;
type Send = (server: ServerHandle) => Promise<Response>;
type Step = readonly [label: string, send: Send, status: number];

// Generated per run, so no signing secret is ever written down.
const SECRETS = { slack: randomBytes(24).toString('hex'), github: randomBytes(24).toString('hex') };
const FORGED = randomBytes(24).toString('hex');
const MISSING = 'mem_000000000000';
const BLOCKED_LINE = 'opened on the server thread by a route';
const REPO = { full_name: 'acme/demo', private: false, owner: { login: 'acme' }, name: 'demo' };

let seed: MovedReadsSeed;
const homes: string[] = [];

const as = (who: keyof Callers = 'main'): string => seed.keys[who];
const drill =
  (tail: string, who?: keyof Callers): Send =>
  (s) =>
    get(s, `/v1/recall/drill/${tail}`, as(who));
const context =
  (query: string, who?: keyof Callers): Send =>
  (s) =>
    get(s, `/v1/context${query}`, as(who));
const outcome =
  (body: JsonValue, who?: keyof Callers): Send =>
  (s) =>
    post(s, '/v1/outcome', body, as(who));
const promote =
  (id: string, who?: keyof Callers): Send =>
  (s) =>
    post(s, `/v1/memories/${id}/promote`, {}, as(who));
const rpc = (method: string, params?: JsonValue): JsonValue =>
  params === undefined ? { jsonrpc: '2.0', id: 1, method } : { jsonrpc: '2.0', id: 1, method, params };
const tool =
  (name: string, args: JsonValue = {}, who?: keyof Callers): Send =>
  (s) =>
    post(s, '/mcp', rpc('tools/call', { name, arguments: args }), as(who));

// One signing second for the file: a wall-clock second per request let a redelivery in the same second hit the
// replay window and one in the next second reach the stored-event check, so the two servers could answer differently.
const SLACK_SECOND = Math.floor(Date.now() / 1000);

function slack(payload: JsonValue, { secret = SECRETS.slack, second = SLACK_SECOND } = {}): Send {
  return (s) => {
    const body = JSON.stringify(payload);
    const ts = String(second);
    const signature = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': signature,
    };
    return fetch(`${s.url}/v1/connectors/slack/events`, { method: 'POST', headers, body });
  };
}

function github(deliveryId: string, payload: JsonValue, secret = SECRETS.github): Send {
  return (s) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const headers = {
      'content-type': 'application/json',
      'x-hub-signature-256': signature,
      'x-github-event': 'issue_comment',
      'x-github-delivery': deliveryId,
    };
    return fetch(`${s.url}/v1/connectors/github/events`, { method: 'POST', headers, body });
  };
}

/** The stream's status, headers and first chunk; the stream itself never ends, so the test hangs up after one read. */
function stream(who?: keyof Callers): Send {
  return async (s) => {
    const hangUp = new AbortController();
    const res = await fetch(`${s.url}/mcp/stream`, {
      headers: { authorization: `Bearer ${as(who)}` },
      signal: hangUp.signal,
    });
    const first = res.body === null ? undefined : (await res.body.getReader().read()).value;
    hangUp.abort();
    return new Response(new TextDecoder().decode(first), { status: res.status, headers: res.headers });
  };
}

const slackEvent = (teamId: string, eventId: string, event: JsonValue) => ({
  type: 'event_callback',
  team_id: teamId,
  event_id: eventId,
  event_time: 1_700_000_000,
  event,
});
const posted = (ts: string) => ({
  type: 'message',
  channel: 'C1',
  channel_type: 'channel',
  user: 'U1',
  text: 'the release is frozen until friday',
  ts,
});
const removed = (ts: string) => ({
  type: 'message',
  subtype: 'message_deleted',
  channel: 'C1',
  deleted_ts: ts,
  ts: '1700.500000',
});
const comment = (action: 'created' | 'deleted') => ({
  action,
  installation: { id: 101 },
  repository: REPO,
  issue: { number: 1 },
  comment: {
    id: 9,
    body: 'I can reproduce this on main',
    user: { login: 'bob', id: 2 },
    updated_at: '2026-02-28T09:00:00Z',
  },
});

const V1_STEPS: readonly Step[] = [
  ['drill a summary', drill('mem_x_summary'), 200],
  ['drill one child', drill('mem_x_summary?limit=1'), 200],
  ['drill a missing summary', drill(MISSING), 404],
  ['drill with a zero limit', drill('mem_x_summary?limit=0'), 400],
  ['drill as the other tenant', drill('mem_x_summary', 'other'), 404],
  ['outcome on ids', outcome({ good: true, ids: ['mem_p_plain', MISSING] }), 200],
  ['outcome with no verdict', outcome({ ids: [] }), 400],
  ['context, reaching the global store', context('?q=deploy'), 200],
  ['outcome on the last recall', outcome({ good: false }), 200],
  ['context with no query', context(''), 200],
  ['context as a member', context('?q=deploy', 'member'), 200],
  ['context with an unknown key', context('?q=deploy', 'unknown'), 401],
  ['promote', promote('mem_p_noise'), 200],
  ['promote a missing memory', promote(MISSING), 404],
  ['promote as the other tenant', promote('mem_p_plain', 'other'), 404],
  ['sleep, a dry run', (s) => post(s, '/v1/sleep', { dry_run: true }, as()), 200],
  ['sleep as a tenant admin', (s) => post(s, '/v1/sleep', { dry_run: true }, as('other')), 403],
];

const WEBHOOK_STEPS: readonly Step[] = [
  ['slack url check', slack({ type: 'url_verification', challenge: 'abc123' }), 200],
  ['slack message', slack(slackEvent('T_ACME', 'Ev_1', posted('1700.000001'))), 200],
  // Slack signs a retry afresh, so the event, not the replay window, is what the store must recognise.
  ['slack redelivery', slack(slackEvent('T_ACME', 'Ev_1', posted('1700.000001')), { second: SLACK_SECOND + 1 }), 200],
  ['slack from an unknown team', slack(slackEvent('T_OTHER', 'Ev_2', posted('1700.000002'))), 200],
  ['slack deletion', slack(slackEvent('T_ACME', 'Ev_3', removed('1700.000001'))), 200],
  ['slack forged', slack(slackEvent('T_ACME', 'Ev_4', posted('1700.000004')), { secret: FORGED }), 401],
  ['github comment', github('d-1', comment('created')), 200],
  ['github deletion', github('d-2', comment('deleted')), 200],
  ['github forged', github('d-3', comment('created'), FORGED), 401],
];

const HOST_STEPS: readonly Step[] = [
  ['mcp tool list', (s) => post(s, '/mcp', rpc('tools/list'), as()), 200],
  ['mcp recall', tool('hippo_recall', { query: 'deploy' }), 200],
  ['mcp drill', tool('hippo_drill', { summary_id: 'mem_x_summary' }), 200],
  // A host admin's context query comes from the server's own git state, which a slow `git diff` can time out of.
  ['mcp context as a member', tool('hippo_context', {}, 'member'), 200],
  ['mcp outcome', tool('hippo_outcome', { good: true }), 200],
  ['mcp remember', tool('hippo_remember', { text: 'the canary needs ten minutes of traffic' }), 200],
  ['mcp share', tool('hippo_share', { id: 'mem_p_plain', force: true }), 200],
  ['mcp share a missing memory', tool('hippo_share', { id: MISSING }), 200],
  ['mcp peers', tool('hippo_peers'), 200],
  ['mcp resolve', tool('hippo_resolve', { conflict_id: 1, keep: 'mem_p_plain' }), 200],
  [
    'mcp resolve, rejecting the loser',
    tool('hippo_resolve', { conflict_id: 2, keep: 'mem_p_fill0', rejectLoser: true }),
    200,
  ],
  ['mcp unknown tool', tool('hippo_nope'), 200],
  ['mcp with a bad body', (s) => postText(s, '/mcp', '{not json', as()), 400],
  ['mcp with an unknown key', tool('hippo_peers', {}, 'unknown'), 401],
  ['mcp stream', stream(), 200],
  ['mcp stream with an unknown key', stream('unknown'), 401],
  ['health', (s) => get(s, '/health'), 200],
  ['ready', (s) => get(s, '/ready'), 200],
];

const STEPS = [...V1_STEPS, ...WEBHOOK_STEPS, ...HOST_STEPS];

const CONFLICT = `INSERT INTO memory_conflicts (memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at, tenant_id)
  VALUES (?, ?, 'seeded contradiction', 0.9, 'open', ?, ?, ?)`;

/** A fresh copy of the seed with two open conflicts, whose Slack team T_ACME and GitHub installation 101 route to the default tenant. */
async function copy() {
  const made = freshStore(seed.templates, 'local');
  homes.push(made.home);
  await sqliteStore(made.root).connectorEvents.registerSlackWorkspace('T_ACME', TENANT);
  onDb(made.root, (db) => {
    db.prepare('INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)').run(
      '101',
      TENANT,
      FAKE_NOW,
    );
    for (const [a, b] of [
      ['mem_p_plain', 'mem_p_noise'],
      ['mem_p_fill0', 'mem_x_cafe'],
    ]) {
      db.prepare(CONFLICT).run(a, b, FAKE_NOW, FAKE_NOW, TENANT);
    }
  });
  // A promote or share embeds its copy after the reply, so a provider would race the server's stop.
  writeFileSync(join(made.globalRoot, 'config.json'), JSON.stringify({ embeddings: { enabled: false } }));
  return made;
}

/** `use` against a server on `root`, on the worker-backed store when `store` is absent; it resolves once the server stopped. */
async function onServer<T>(
  root: string,
  store: HippoStore | undefined,
  use: (server: ServerHandle) => Promise<T>,
): Promise<T> {
  const base = { hippoRoot: root, port: 0, rateLimits: { perCaller: 'off' as const } };
  const server = await serve(store ? { ...base, store } : base);
  try {
    return await use(server);
  } finally {
    await server.stop();
    await store?.close();
  }
}

/** A global copy's id and its source's folder label are minted per run. */
const runFree = (text: string): string =>
  text.replace(/g_[0-9a-f]+/g, '<global>').replace(/hippo-parity-[\w-]+/gi, '<home>');

/** Connector writes mint random memory ids, so rows are compared by content, in sorted order. */
const rowsAt = (root: string): string[] =>
  leftBehind(root)
    .map((row) => runFree(scrub(row)))
    .sort();

async function runSteps(inProcess: boolean) {
  const { root, globalRoot } = await copy();
  const replies = await onServer(root, inProcess ? sqliteStore(root) : undefined, async (server) => {
    const seenSoFar = [];
    for (const [label, send] of STEPS) {
      const reply = await seen(label, await send(server), seed.keyIds);
      seenSoFar.push({ ...reply, body: runFree(reply.body) });
    }
    return seenSoFar;
  });
  return {
    replies,
    audit: auditRows(root, seed.keyIds),
    stored: rowsAt(root),
    global: rowsAt(globalRoot),
    mirrors: mirrorFiles(root),
  };
}

// Seeding the template stores row by row runs past the 30 s hook default on a slow runner.
beforeAll(async () => {
  seed = await seedMovedReads();
}, 120_000);

afterAll(() => {
  for (const dir of [seed.templates.dir, ...homes]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

beforeEach(() => {
  for (const name of CLEARED_ENV) vi.stubEnv(name, '');
  vi.stubEnv('HIPPO_FAKE_NOW', FAKE_NOW);
  vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.stubEnv('SLACK_SIGNING_SECRET', SECRETS.slack);
  vi.stubEnv('GITHUB_WEBHOOK_SECRET', SECRETS.github);
});

afterEach(async () => {
  await undoAll();
});

describe('the routes moved off the server thread, on store workers against the in-process store', () => {
  it('gives each the same status, headers, body, audit rows, stored rows, global rows and mirror files', async () => {
    const inProcess = await runSteps(true);
    const onWorkers = await runSteps(false);

    expect(onWorkers.replies).toEqual(inProcess.replies);
    expect(onWorkers.audit).toEqual(inProcess.audit);
    expect(onWorkers.stored).toEqual(inProcess.stored);
    expect(onWorkers.global).toEqual(inProcess.global);
    expect(onWorkers.mirrors).toEqual(inProcess.mirrors);
    expect(onWorkers.replies.map((reply) => [reply.label, reply.status])).toEqual(
      STEPS.map(([label, , status]) => [label, status]),
    );
    const bodyOf = Object.fromEntries(onWorkers.replies.map((reply) => [reply.label, reply.body]));
    expect(bodyOf['context, reaching the global store']).toContain('global store about rollbacks');
    expect(bodyOf['slack message']).toContain('"status":"ingested"');
    expect(bodyOf['slack redelivery']).toBe('{"ok":true,"status":"duplicate","memoryId":"<memory>"}');
    expect(bodyOf['github deletion']).toContain('"status":"archived"');
    expect(bodyOf['mcp stream']).toBe(': ping\n\n');
    expect(bodyOf['mcp resolve']).toContain('weakened');
    expect(bodyOf['mcp resolve, rejecting the loser']).toContain('rejected (tombstoned) and removed');
    expect(bodyOf['promote']).toBe('{"ok":true,"sourceId":"mem_p_noise","globalId":"<global>"}');
    expect(bodyOf['mcp share']).toContain('Shared [<global>] to global store');
    // The promoted and the shared copy both name the project folder.
    expect(bodyOf['mcp peers']).toContain('<home>: 2 memories');
    expect(onWorkers.global.filter((row) => row.startsWith('memories '))).toHaveLength(3);
  });
});

describe('the server-thread block of the routes this file covers', () => {
  const ROUTES: ReadonlyArray<
    readonly [route: string, swapped: (inProcess: InProcess) => Partial<InProcess>, send: Send, status: number]
  > = [
    ['GET /v1/recall/drill/:id', (p) => ({ dagReads: p.dagReads }), drill('mem_x_summary'), 501],
    [
      'POST /v1/outcome with ids',
      (p) => ({ entryWrites: p.entryWrites }),
      outcome({ good: true, ids: ['mem_p_plain'] }),
      501,
    ],
    ['POST /v1/outcome on the last recall', (p) => ({ entryWrites: p.entryWrites }), outcome({ good: true }), 501],
    ['GET /v1/context', (p) => ({ contextReads: p.contextReads }), context('?q=deploy'), 501],
    [
      'POST /v1/connectors/slack/events',
      (p) => ({ connectorEvents: p.connectorEvents }),
      slack(slackEvent('T_ACME', 'Ev_1', posted('1700.000001'))),
      501,
    ],
    [
      'POST /v1/connectors/github/events',
      (p) => ({ connectorEvents: p.connectorEvents }),
      github('d-1', comment('created')),
      501,
    ],
    ['GET /mcp/stream', (p) => ({ findApiKey: p.findApiKey }), stream(), 501],
    [
      'POST /mcp, which answers in JSON-RPC',
      (p) => ({ searchRecallEntries: p.searchRecallEntries }),
      tool('hippo_recall', { query: 'deploy' }),
      200,
    ],
    [
      'POST /mcp hippo_resolve',
      (p) => ({ conflicts: p.conflicts }),
      tool('hippo_resolve', { conflict_id: 2, keep: 'mem_p_fill0', rejectLoser: true }),
      200,
    ],
    ['POST /v1/memories/:id/promote', (p) => ({ entriesByIds: p.entriesByIds }), promote('mem_p_noise'), 501],
    [
      'POST /mcp hippo_share',
      (p) => ({ entriesByIds: p.entriesByIds }),
      tool('hippo_share', { id: 'mem_p_plain', force: true }),
      200,
    ],
  ];

  it.each(ROUTES)(
    '%s fails when its handler opens hippo.db on the server thread',
    async (_route, swapped, send, status) => {
      const { root } = await copy();
      const info = vi.spyOn(log, 'info');
      // The worker-backed store with one group or method swapped back to the in-process one: the defect the block exists to catch.
      const store = Object.assign(workerSqliteStore(root), swapped(sqliteStore(root)));

      const res = await onServer(root, store, async (server) => seen('blocked', await send(server)));

      expect(res.status).toBe(status);
      if (status === 200) expect(res.body).toContain('"code":-32603');
      expect(info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes(BLOCKED_LINE))).toHaveLength(
        1,
      );
    },
  );
});
