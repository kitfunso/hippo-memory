// With ctx.store, connector ingest and deletion run on the store's connectorEvents and connectorWrites groups from the entry point
// down, and both webhooks serve from a folder that never holds a hippo.db.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Context } from '../src/api/index.js';
import { handleCommentDeleted } from '../src/connectors/github/deletion.js';
import { ingestEvent } from '../src/connectors/github/ingest.js';
import { handleMessageDeleted } from '../src/connectors/slack/deletion.js';
import { ingestMessage } from '../src/connectors/slack/ingest.js';
import { closeHippoDb, openHippoDb, withSqliteBlocked } from '../src/db/index.js';
import { STORE_NOT_PORTED_MESSAGE } from '../src/util/http-util.js';
import type { JsonValue } from '../src/util/json.js';
import { OTHER_STORE_MARKER, serve, type HippoStore, type ServerHandle } from '../src/server.js';
import { upsertSlackWorkspace } from '../src/store/connectors/slack.js';
import { inMemoryConnectorEventsStore, type InMemoryConnectorEventsStore } from './_helpers/in-memory-connector-events-store.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:00.000Z';
const slackActor: Actor = { subject: 'connector:slack', role: 'admin' };
const githubActor: Actor = { subject: 'connector:github', role: 'admin' };
const REPO = { full_name: 'acme/demo', private: false, owner: { login: 'acme' }, name: 'demo' };
const MESSAGE_REF = 'slack://T1/C1/1700.000001';
const COMMENT_REF = 'github://acme/demo/issue/1/comment/9';
let fixture: TwoTenantFixture;
let home: string;
let n = 0;

function copyOf(): string {
  const root = join(home, `copy-${String(++n)}`);
  cpSync(fixture.dir, root, { recursive: true });
  return root;
}

/** A folder whose marker names another store, so a hippo.db open in it throws and creates nothing. */
function markedFolder(): string {
  const root = join(home, `marked-${String(++n)}`);
  mkdirSync(root);
  writeFileSync(join(root, OTHER_STORE_MARKER), 'in-memory\n');
  return root;
}

/** A copy that routes Slack team T_ACME and GitHub installation 101 to acme, so any other sender is unroutable. */
function copyWithRoutes(): string {
  const root = copyOf();
  upsertSlackWorkspace(root, 'T_ACME', TENANT_A);
  const db = openHippoDb(root);
  try {
    db.prepare('INSERT INTO github_installations (installation_id, tenant_id, added_at) VALUES (?, ?, ?)').run('101', TENANT_A, NOW);
  } finally {
    closeHippoDb(db);
  }
  return root;
}

const slackRows = (memory: InMemoryConnectorEventsStore) => memory.events().filter((e) => e.connector === 'slack').map((e) => [e.eventKey, e.memoryId]);
const githubRows = (memory: InMemoryConnectorEventsStore) =>
  memory.events().filter((e) => e.connector === 'github').map((e) => [e.deliveryId, e.eventName, e.memoryId]).sort();

beforeAll(() => {
  fixture = seedTwoTenants();
  home = mkdtempSync(join(tmpdir(), 'hippo-connector-events-store-'));
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('the connector entry points on a store with connectorEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ingest, redelivery, empty body, deletion and unknown deletion answer from the store with hippo.db blocked and none created in hippoRoot', async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryConnectorEventsStore(copyOf());
    const slack: Context = { hippoRoot, tenantId: TENANT_A, actor: slackActor, store: memory.store };
    const github: Context = { ...slack, actor: githubActor };
    const message = (eventId: string, text: string, ts: string) =>
      ingestMessage(slack, { teamId: 'T1', channel: { id: 'C1', is_private: false }, message: { type: 'message', channel: 'C1', user: 'U1', text, ts }, eventId });
    const comment = (deliveryId: string) => ingestEvent(github, {
      event: { eventName: 'issue_comment', payload: { action: 'created', repository: REPO, issue: { number: 1 }, comment: { id: 9, body: 'I can reproduce this on main', user: { login: 'bob', id: 2 } } } },
      rawBody: '{}', deliveryId,
    });
    const deleted = (eventId: string, deletedTs: string) => handleMessageDeleted(slack, { teamId: 'T1', channelId: 'C1', deletedTs, eventId });
    const commentDeleted = (deliveryId: string) =>
      handleCommentDeleted(github, { artifactRef: COMMENT_REF, idempotencyKey: 'deleted-comment-9', deliveryId, eventName: 'issue_comment' });

    const ids = await withSqliteBlocked('in-memory', async () => {
      const stored = await message('Ev_message', 'the release is frozen until friday', '1700.000001');
      expect(stored).toEqual({ status: 'ingested', memoryId: expect.any(String) });
      expect(await message('Ev_message', 'the release is frozen until friday', '1700.000001')).toEqual({ status: 'duplicate', memoryId: stored.memoryId });
      expect(await message('Ev_empty', '   ', '1700.000002')).toEqual({ status: 'skipped', memoryId: null });
      expect(await message('Ev_empty', '   ', '1700.000002')).toEqual({ status: 'skipped', memoryId: null });
      const noted = await comment('d-1');
      expect(noted).toEqual({ status: 'ingested', memoryId: expect.any(String) });
      expect(await comment('d-2')).toEqual({ status: 'duplicate', memoryId: noted.memoryId });
      const held = await memory.store.entriesByIds([stored.memoryId ?? '', noted.memoryId ?? ''], TENANT_A);
      expect(new Map(held.map((r) => [r.id, [r.kind, r.artifact_ref]]))).toEqual(new Map([[stored.memoryId, ['raw', MESSAGE_REF]], [noted.memoryId, ['raw', COMMENT_REF]]]));

      expect(await deleted('Ev_deleted', '1700.000001')).toEqual({ status: 'archived', memoryId: stored.memoryId });
      expect(await deleted('Ev_deleted', '1700.000001')).toEqual({ status: 'duplicate', memoryId: null });
      expect(await deleted('Ev_unknown', '1700.999999')).toEqual({ status: 'not_found', memoryId: null });
      expect(await deleted('Ev_unknown', '1700.999999')).toEqual({ status: 'duplicate', memoryId: null });
      expect(await commentDeleted('d-3')).toEqual({ status: 'archived', archivedCount: 1 });
      expect(await commentDeleted('d-4')).toEqual({ status: 'duplicate', archivedCount: 0 });
      expect(await memory.store.entriesByIds([stored.memoryId ?? '', noted.memoryId ?? ''], TENANT_A)).toEqual([]);
      return { message: stored.memoryId, comment: noted.memoryId };
    });

    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(slackRows(memory)).toEqual([['Ev_deleted', ids.message], ['Ev_empty', null], ['Ev_message', ids.message], ['Ev_unknown', null]]);
    expect(githubRows(memory)).toEqual([['d-1', 'issue_comment', ids.comment], ['d-3', 'issue_comment', ids.comment]]);
    expect(memory.auditRows().filter((r) => r.ts === NOW).map((r) => [r.op, r.targetId, r.actor, r.tenantId])).toEqual([
      ['remember', ids.message, 'connector:slack', TENANT_A], ['remember', ids.comment, 'connector:github', TENANT_A],
      ['archive_raw', ids.message, 'connector:slack', TENANT_A], ['archive_raw', ids.comment, 'connector:github', TENANT_A],
    ]);
    expect(memory.letters()).toEqual([]);
  });
});

describe('both webhooks under a store that is not hippo.db', () => {
  // Generated per run, so no signing secret is ever written down.
  const secrets = { slack: randomBytes(24).toString('hex'), github: randomBytes(24).toString('hex') };
  const handles: ServerHandle[] = [];
  let memory: InMemoryConnectorEventsStore;
  let served: { readonly root: string; readonly url: string };
  let baseline: number;

  const serveOn = async (store: HippoStore): Promise<{ root: string; url: string }> => {
    const root = markedFolder();
    const handle = await serve({ hippoRoot: root, port: 0, store });
    handles.push(handle);
    return { root, url: handle.url };
  };
  const slackSignature = (ts: string, body: string, secret: string): string => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
  const postSlack = async (url: string, payload: JsonValue, secret = secrets.slack) => {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(ts, body, secret) };
    const res = await fetch(`${url}/v1/connectors/slack/events`, { method: 'POST', headers, body });
    return { status: res.status, body: await res.json(), sent: { body, ts, signature: headers['x-slack-signature'] } };
  };
  const postGithub = async (url: string, deliveryId: string, payload: JsonValue, secret = secrets.github) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const headers = { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'issue_comment', 'x-github-delivery': deliveryId };
    const res = await fetch(`${url}/v1/connectors/github/events`, { method: 'POST', headers, body });
    return { status: res.status, body: await res.json() };
  };
  const slackEvent = (teamId: string, eventId: string, event: JsonValue) => ({ type: 'event_callback', team_id: teamId, event_id: eventId, event_time: 1_700_000_000, event });
  const posted = (ts: string) => ({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'the release is frozen until friday', ts });
  const removed = (ts: string) => ({ type: 'message', subtype: 'message_deleted', channel: 'C1', deleted_ts: ts, ts: '1700.500000' });
  const commentEvent = (action: 'created' | 'deleted') => ({
    action, installation: { id: 101 }, repository: REPO, issue: { number: 1 },
    comment: { id: 9, body: 'I can reproduce this on main', user: { login: 'bob', id: 2 }, updated_at: '2026-02-28T09:00:00Z' },
  });
  const added = () => memory.auditRows().slice(baseline).map((r) => [r.op, r.targetId, r.actor, r.tenantId]);
  const rows = () => ({ slack: slackRows(memory), github: githubRows(memory), letters: memory.letters().length, audit: added().length });

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('SLACK_SIGNING_SECRET', secrets.slack);
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', secrets.github);
    memory = inMemoryConnectorEventsStore(copyWithRoutes());
    served = await serveOn(memory.store);
    baseline = memory.auditRows().length;
  });

  afterAll(async () => {
    for (const handle of handles) await handle.stop();
    vi.unstubAllEnvs();
  });

  it('a store with both connector groups stores, dedupes, parks and archives signed deliveries, and its folder never gets a hippo.db', async () => {
    const stored = await postSlack(served.url, slackEvent('T_ACME', 'Ev_message', posted('1700.000001')));
    expect(stored).toMatchObject({ status: 200, body: { ok: true, status: 'ingested', memoryId: expect.any(String) } });
    const memoryId: string = stored.body.memoryId;
    expect(await postSlack(served.url, slackEvent('T_ACME', 'Ev_message', posted('1700.000001')))).toMatchObject({ status: 200, body: { ok: true, status: 'duplicate', memoryId } });
    const stray = await postSlack(served.url, slackEvent('T_OTHER', 'Ev_stray', posted('1700.000003')));
    expect(stray).toMatchObject({ status: 200, body: { ok: true, status: 'dlq' } });
    expect(await postSlack(served.url, slackEvent('T_ACME', 'Ev_deleted', removed('1700.000001')))).toMatchObject({ status: 200, body: { ok: true, status: 'archived' } });
    const noted = await postGithub(served.url, 'd-1', commentEvent('created'));
    expect(noted).toEqual({ status: 200, body: { ok: true, status: 'ingested', memoryId: expect.any(String) } });
    const commentId: string = noted.body.memoryId;
    expect(await postGithub(served.url, 'd-2', commentEvent('deleted'))).toEqual({ status: 200, body: { ok: true, status: 'archived', archivedCount: 1 } });

    expect(slackRows(memory)).toEqual([['Ev_deleted', memoryId], ['Ev_message', memoryId]]);
    expect(githubRows(memory)).toEqual([['d-1', 'issue_comment', commentId], ['d-2', 'issue_comment', commentId]]);
    expect(added()).toEqual([
      ['remember', memoryId, 'connector:slack', TENANT_A], ['archive_raw', memoryId, 'connector:slack', TENANT_A],
      ['remember', commentId, 'connector:github', TENANT_A], ['archive_raw', commentId, 'connector:github', TENANT_A],
    ]);
    expect(memory.letters()).toMatchObject([{
      connector: 'slack', id: 1, tenantId: '__unroutable__', bucket: 'unroutable', error: 'unroutable team_id: T_OTHER', teamId: 'T_OTHER',
      rawPayload: stray.sent.body, signature: stray.sent.signature, slackTimestamp: stray.sent.ts,
    }]);
    expect(readdirSync(served.root).sort()).toEqual([OTHER_STORE_MARKER, 'server.pid']);
  });

  it('a delivery signed with another secret is a 401 and adds no event, letter or audit row', async () => {
    const before = rows();
    const other = randomBytes(24).toString('hex');
    expect(await postSlack(served.url, slackEvent('T_ACME', 'Ev_forged', posted('1700.000009')), other)).toMatchObject({ status: 401, body: { error: 'invalid Slack signature' } });
    expect(await postGithub(served.url, 'd-forged', commentEvent('created'), other)).toEqual({ status: 401, body: { error: 'invalid GitHub signature' } });
    expect(rows()).toEqual(before);
  });

  it('a store missing either connector group answers 501 store_not_ported to a signed delivery and stores nothing, not even the event of an unknown deletion', async () => {
    const before = rows();
    const refused = { status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } };
    const noEvents = await serveOn({ ...memory.store, connectorEvents: undefined });
    const noWrites = await serveOn({ ...memory.store, connectorWrites: undefined });
    expect(await postSlack(noEvents.url, slackEvent('T_ACME', 'Ev_refused', posted('1700.000010')))).toMatchObject(refused);
    expect(await postGithub(noEvents.url, 'd-refused', commentEvent('created'))).toEqual(refused);
    expect(await postSlack(noWrites.url, slackEvent('T_ACME', 'Ev_unknown', removed('1700.999999')))).toMatchObject(refused);
    expect(await postGithub(noWrites.url, 'd-unknown', { ...commentEvent('deleted'), issue: { number: 77 } })).toEqual(refused);
    expect(rows()).toEqual(before);
  });
});
