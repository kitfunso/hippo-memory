// The memory write, key, audit and session assemble routes run their SQLite work on worker threads, and so does the key row read of every request.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintApiKey, revokeApiKey } from '../src/store/auth.js';
import { getHippoDbPath } from '../src/db.js';
import { startWalCheckpointer } from '../src/db/wal-checkpointer.js';
import { log } from '../src/log.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer } from '../src/memory.js';
import { insertRejectedValue, rejectionDigest } from '../src/store/rejection.js';
import type { ServerHandle } from '../src/server.js';
import type { HippoStore, StoreGroups } from '../src/store-port.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { predictionMirror } from '../src/store/predictions.js';
import { createSqliteExecutor, type SqliteExecutor } from '../src/store/sqlite/executor.js';
import { sqliteStore } from '../src/store/sqlite/store.js';
import { workerSqliteStore } from '../src/store/sqlite/worker-store.js';
import {
  auditFailures, auditRows, cleanups, del, execOn, get, holdWriteLock, keyFor, mirrorFiles, newRoot, onDb, patientStore, post, postText, removeLater, scrub, seen, start, undoAll, watched,
} from './_helpers/store-worker-server.js';

afterEach(async () => {
  vi.useRealTimers();
  await undoAll();
});

const KEY_READ = 'base.findApiKey';
const REFUSED = 'the value a person rejected';

function contents(root: string): string[] {
  // SAFETY: the SELECT names one column, which the schema declares TEXT NOT NULL.
  const rows = onDb(root, (db) => db.prepare('SELECT content FROM memories ORDER BY content').all()) as Array<{ content: string }>;
  return rows.map((row) => row.content);
}

/** Raw rows of one session, written in process before the server starts; returns their ids. */
function seedSession(root: string, tenantId: string, sessionId: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const entry = createMemory(`${tenantId} ${sessionId} message ${i}`, {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, layer: Layer.Buffer, confidence: 'observed', kind: 'raw', source_session_id: sessionId, tenantId,
    });
    entry.created = `2026-01-0${i + 1}T00:00:00.000Z`;
    writeEntry(root, entry);
    return entry.id;
  });
}

function rejectValue(root: string, tenantId: string, content: string): void {
  onDb(root, (db) => insertRejectedValue(db, {
    tenantId, digest: rejectionDigest(content), reason: 'wrong', rejectedBy: 'test', rejectedAt: new Date().toISOString(), normalizedChars: content.length,
  }));
}

const keyIdOf = (plaintext: string): string => plaintext.slice(0, plaintext.indexOf('.'));

interface Caller {
  readonly main: string;
  readonly other: string;
  readonly member: string;
  readonly revoked: string;
  readonly expired: string;
  /** Well formed, and in no store. */
  readonly unknown: string;
}

function seedCallers(root: string) {
  const main = keyFor(root, 'default');
  const other = keyFor(root, 'acme');
  const member = keyFor(root, 'default', { role: 'member' });
  const revoked = keyFor(root, 'default');
  onDb(root, (db) => revokeApiKey(db, revoked.keyId));
  const expired = keyFor(root, 'default', { expiresAt: '2020-01-01T00:00:00.000Z' });
  const keys: Caller = { main: main.plaintext, other: other.plaintext, member: member.plaintext, revoked: revoked.plaintext, expired: expired.plaintext, unknown: mintApiKey().plaintext };
  return { keys, keyIds: [main, other, member, revoked, expired].map((key) => key.keyId) };
}

interface Run {
  readonly server: ServerHandle;
  readonly keys: Caller;
  /** `<step label>.<field>` of every id an earlier reply named. */
  readonly made: Map<string, string>;
}

type Step = readonly [label: string, send: (run: Run) => Promise<Response>];

const NAMED = /"(id|newId|keyId|plaintext)":"([^"]+)"/g;
const MISSING_MEMORY = '/v1/memories/mem_000000000000';

const of = (run: Run, name: string): string => run.made.get(name) ?? 'named-by-no-earlier-step';
const memory = (run: Run, step: string, tail = ''): string => `/v1/memories/${of(run, `${step}.id`)}${tail}`;

const MEMORY_STEPS: readonly Step[] = [
  ['create', (r) => post(r.server, '/v1/memories', { content: 'the first note', kind: 'raw' }, r.keys.main)],
  ['create a second', (r) => post(r.server, '/v1/memories', { content: 'the second note', tags: ['kept'] }, r.keys.main)],
  ['create a third', (r) => post(r.server, '/v1/memories', { content: 'the third note' }, r.keys.main)],
  ['create for the other tenant', (r) => post(r.server, '/v1/memories', { content: 'their note', kind: 'raw' }, r.keys.other)],
  ['create as a member', (r) => post(r.server, '/v1/memories', { content: 'a member note' }, r.keys.member)],
  ['create without content', (r) => post(r.server, '/v1/memories', { kind: 'raw' }, r.keys.main)],
  ['create with an invalid kind', (r) => post(r.server, '/v1/memories', { content: 'never saved', kind: 'bogus' }, r.keys.main)],
  ['create with a broken body', (r) => postText(r.server, '/v1/memories', '{', r.keys.main)],
  ['create a rejected value', (r) => post(r.server, '/v1/memories', { content: REFUSED }, r.keys.main)],
  ['create with an unknown key', (r) => post(r.server, '/v1/memories', { content: 'never saved' }, r.keys.unknown)],
  ['create with a revoked key', (r) => post(r.server, '/v1/memories', { content: 'never saved' }, r.keys.revoked)],
  ['create with an expired key', (r) => post(r.server, '/v1/memories', { content: 'never saved' }, r.keys.expired)],
  ['supersede', (r) => post(r.server, memory(r, 'create a second', '/supersede'), { content: 'the second note, corrected' }, r.keys.main)],
  ['supersede it again', (r) => post(r.server, memory(r, 'create a second', '/supersede'), { content: 'the second note, corrected twice' }, r.keys.main)],
  ['supersede without content', (r) => post(r.server, memory(r, 'create a third', '/supersede'), {}, r.keys.main)],
  ['supersede with a rejected value', (r) => post(r.server, memory(r, 'create a third', '/supersede'), { content: REFUSED }, r.keys.main)],
  ['supersede a missing row', (r) => post(r.server, `${MISSING_MEMORY}/supersede`, { content: 'never saved' }, r.keys.main)],
  ["supersede the other tenant's row", (r) => post(r.server, memory(r, 'create for the other tenant', '/supersede'), { content: 'never saved' }, r.keys.main)],
  ['supersede with an unknown key', (r) => post(r.server, memory(r, 'create a third', '/supersede'), { content: 'never saved' }, r.keys.unknown)],
  ['archive', (r) => post(r.server, memory(r, 'create', '/archive'), { reason: 'no longer needed' }, r.keys.main)],
  ['archive it again', (r) => post(r.server, memory(r, 'create', '/archive'), { reason: 'no longer needed' }, r.keys.main)],
  ['archive without a reason', (r) => post(r.server, memory(r, 'create', '/archive'), {}, r.keys.main)],
  ['archive a row that is not raw', (r) => post(r.server, memory(r, 'create a third', '/archive'), { reason: 'not raw' }, r.keys.main)],
  ['archive a missing row', (r) => post(r.server, `${MISSING_MEMORY}/archive`, { reason: 'missing' }, r.keys.main)],
  ["archive the other tenant's row", (r) => post(r.server, memory(r, 'create for the other tenant', '/archive'), { reason: 'theirs' }, r.keys.main)],
  ['archive with a revoked key', (r) => post(r.server, memory(r, 'create', '/archive'), { reason: 'refused' }, r.keys.revoked)],
  ['forget', (r) => del(r.server, memory(r, 'create a third'), r.keys.main)],
  ['forget it again', (r) => del(r.server, memory(r, 'create a third'), r.keys.main)],
  ['forget a missing row', (r) => del(r.server, MISSING_MEMORY, r.keys.main)],
  ["forget the other tenant's row", (r) => del(r.server, memory(r, 'create for the other tenant'), r.keys.main)],
  ['forget with an expired key', (r) => del(r.server, memory(r, 'create a second'), r.keys.expired)],
  ['assemble', (r) => get(r.server, '/v1/sessions/sess-1/assemble', r.keys.main)],
  ['assemble a small budget', (r) => get(r.server, '/v1/sessions/sess-1/assemble?budget=5&freshTail=1', r.keys.main)],
  ['assemble an unknown session', (r) => get(r.server, '/v1/sessions/sess-none/assemble', r.keys.main)],
  ['assemble a bad budget', (r) => get(r.server, '/v1/sessions/sess-1/assemble?budget=0', r.keys.main)],
  ['assemble as the other tenant', (r) => get(r.server, '/v1/sessions/sess-1/assemble', r.keys.other)],
  ['assemble with an unknown key', (r) => get(r.server, '/v1/sessions/sess-1/assemble', r.keys.unknown)],
];

const KEY_STEPS: readonly Step[] = [
  ['mint', (r) => post(r.server, '/v1/auth/keys', { label: 'minted', role: 'member' }, r.keys.main)],
  ['mint with no role', (r) => post(r.server, '/v1/auth/keys', { label: 'defaulted' }, r.keys.main)],
  ['mint with a bad role', (r) => post(r.server, '/v1/auth/keys', { role: 'root' }, r.keys.main)],
  ['mint with a broken body', (r) => postText(r.server, '/v1/auth/keys', '{', r.keys.main)],
  ['mint as a member', (r) => post(r.server, '/v1/auth/keys', { label: 'refused' }, r.keys.member)],
  ['mint with an unknown key', (r) => post(r.server, '/v1/auth/keys', { label: 'refused' }, r.keys.unknown)],
  ['list keys with the minted key', (r) => get(r.server, '/v1/auth/keys', of(r, 'mint.plaintext'))],
  ['list keys', (r) => get(r.server, '/v1/auth/keys', r.keys.main)],
  ['list keys, the dead ones too', (r) => get(r.server, '/v1/auth/keys?active=false', r.keys.main)],
  ['list keys one per page', (r) => get(r.server, '/v1/auth/keys?limit=1', r.keys.main)],
  ['list keys with a bad active', (r) => get(r.server, '/v1/auth/keys?active=maybe', r.keys.main)],
  ['list keys as the other tenant', (r) => get(r.server, '/v1/auth/keys', r.keys.other)],
  ['list keys with a revoked key', (r) => get(r.server, '/v1/auth/keys', r.keys.revoked)],
  ['revoke', (r) => del(r.server, `/v1/auth/keys/${of(r, 'mint.keyId')}`, r.keys.main)],
  ['revoke it again', (r) => del(r.server, `/v1/auth/keys/${of(r, 'mint.keyId')}`, r.keys.main)],
  ['revoke a missing key', (r) => del(r.server, `/v1/auth/keys/${keyIdOf(r.keys.unknown)}`, r.keys.main)],
  ["revoke the other tenant's key", (r) => del(r.server, `/v1/auth/keys/${keyIdOf(r.keys.other)}`, r.keys.main)],
  ['revoke as a member', (r) => del(r.server, `/v1/auth/keys/${keyIdOf(r.keys.main)}`, r.keys.member)],
  ['revoke with an expired key', (r) => del(r.server, `/v1/auth/keys/${keyIdOf(r.keys.main)}`, r.keys.expired)],
  ['list keys with the minted key, now revoked', (r) => get(r.server, '/v1/auth/keys', of(r, 'mint.plaintext'))],
  ['audit', (r) => get(r.server, '/v1/audit', r.keys.main)],
  ['audit one op', (r) => get(r.server, '/v1/audit?op=remember', r.keys.main)],
  ['audit one per page', (r) => get(r.server, '/v1/audit?limit=1', r.keys.main)],
  ['audit an invalid op', (r) => get(r.server, '/v1/audit?op=bogus', r.keys.main)],
  ['audit since a bad date', (r) => get(r.server, '/v1/audit?since=never', r.keys.main)],
  ['audit another tenant', (r) => get(r.server, '/v1/audit?tenant=acme', r.keys.member)],
  ['audit as a member', (r) => get(r.server, '/v1/audit', r.keys.member)],
  ['audit as the other tenant', (r) => get(r.server, '/v1/audit', r.keys.other)],
  ['audit with an unknown key', (r) => get(r.server, '/v1/audit', r.keys.unknown)],
];

const STEPS = [...MEMORY_STEPS, ...KEY_STEPS];

const STORED = {
  memories: `SELECT tenant_id, kind, layer, content, tags_json, source, confidence, scope, owner, artifact_ref, source_session_id, origin_project,
    superseded_by IS NOT NULL AS superseded FROM memories ORDER BY content, kind`,
  archive: 'SELECT reason, archived_by, mirror_cleaned_at IS NOT NULL AS cleaned FROM raw_archive ORDER BY id',
  keys: 'SELECT tenant_id, label, role, owner_subject, revoked_at IS NOT NULL AS revoked, expires_at IS NOT NULL AS expires FROM api_keys ORDER BY id',
  counters: `SELECT key, value FROM meta WHERE key LIKE 'total_%' ORDER BY key`,
  tokens: 'SELECT tenant_id, session_id, surface, event, items, tokens FROM token_ledger ORDER BY id',
} as const;

function storedRows(root: string, keyIds: readonly string[]): string[] {
  return onDb(root, (db) => Object.entries(STORED).flatMap(([table, sql]) => db.prepare(sql).all().map((row) => `${table} ${scrub(JSON.stringify(row), keyIds)}`)));
}

/** Every step against a fresh store, plus what the steps left in the audit log, the tables and the mirror files. */
async function runSteps(root: string, store?: HippoStore) {
  const { keys, keyIds } = seedCallers(root);
  seedSession(root, 'default', 'sess-1', 3);
  seedSession(root, 'acme', 'sess-1', 1);
  rejectValue(root, 'default', REFUSED);
  const run: Run = { server: await start(root, store), keys, made: new Map() };
  const replies = [];
  for (const [label, send] of STEPS) {
    const res = await send(run);
    for (const [, field = '', value = ''] of (await res.clone().text()).matchAll(NAMED)) run.made.set(`${label}.${field}`, value);
    replies.push(await seen(label, res, keyIds));
  }
  return { replies, audit: auditRows(root, keyIds), stored: storedRows(root, keyIds), mirrors: mirrorFiles(root) };
}

describe('the worker-backed write, key and audit routes against the in-process store', () => {
  it('gives every moved route the same status, headers, body, audit rows, stored rows and mirror files', async () => {
    const inProcessRoot = newRoot();
    const inProcess = await runSteps(inProcessRoot, sqliteStore(inProcessRoot));
    const onWorkers = await runSteps(newRoot());

    expect(onWorkers.replies).toEqual(inProcess.replies);
    expect(onWorkers.audit).toEqual(inProcess.audit);
    expect(onWorkers.stored).toEqual(inProcess.stored);
    expect(onWorkers.mirrors).toEqual(inProcess.mirrors);
    const statusOf = Object.fromEntries(onWorkers.replies.map((reply) => [reply.label, reply.status]));
    expect(statusOf).toMatchObject({
      create: 200, 'create without content': 400, 'create a rejected value': 400, 'create with an unknown key': 401, 'create with a revoked key': 401,
      'create with an expired key': 401, supersede: 200, 'supersede a missing row': 404, "supersede the other tenant's row": 404, archive: 200,
      "archive the other tenant's row": 404, forget: 200, 'forget it again': 404, assemble: 200, 'assemble a bad budget': 400, mint: 200,
      'mint as a member': 403, 'list keys with the minted key': 200, 'list keys': 200, revoke: 200, 'revoke a missing key': 404, 'revoke as a member': 403,
      'list keys with the minted key, now revoked': 401, audit: 200, 'audit an invalid op': 400, 'audit another tenant': 403, 'audit with an unknown key': 401,
    });
    expect(onWorkers.audit.filter((row) => row.includes('"reject_refusal"'))).toHaveLength(2);
    expect(onWorkers.mirrors.length).toBeGreaterThan(4);
  });

  it('answers a write behind a held lock with the same 503 and Retry-After, and a read with its 200', async () => {
    const busyReplies = async (root: string, store?: HippoStore) => {
      const [memoryId = ''] = seedSession(root, 'default', 'sess-1', 1);
      const key = keyFor(root, 'default');
      const server = await start(root, store);
      const lock = holdWriteLock(root);
      const replies = [
        await seen('create', await post(server, '/v1/memories', { content: 'refused' }, key.plaintext), [key.keyId]),
        await seen('archive', await post(server, `/v1/memories/${memoryId}/archive`, { reason: 'refused' }, key.plaintext), [key.keyId]),
        await seen('mint', await post(server, '/v1/auth/keys', { label: 'refused', role: 'member' }, key.plaintext), [key.keyId]),
        await seen('list keys', await get(server, '/v1/auth/keys', key.plaintext), [key.keyId]),
        await seen('audit', await get(server, '/v1/audit', key.plaintext), [key.keyId]),
      ];
      lock.release();
      return replies;
    };
    const inProcessRoot = newRoot();
    const inProcess = await busyReplies(inProcessRoot, sqliteStore(inProcessRoot));
    const workerRoot = newRoot();
    const onWorkers = await busyReplies(workerRoot);

    expect(onWorkers).toEqual(inProcess);
    expect(onWorkers.map((reply) => reply.status)).toEqual([503, 503, 503, 200, 200]);
    expect(onWorkers[0]?.headers).toContainEqual(['retry-after', '1']);
    expect(contents(workerRoot)).toEqual(['default sess-1 message 0']);
  });
});

describe('the event loop while a memory write waits', () => {
  it('answers authenticated audit and key reads while a memory write waits for the write lock, then lands the write', async () => {
    const root = newRoot();
    const key = keyFor(root, 'default');
    const { store, sent } = patientStore(root);
    const server = await start(root, store);
    expect((await post(server, '/v1/memories', { content: 'warms the writer' }, key.plaintext)).status).toBe(200);

    const lock = holdWriteLock(root);
    const order: string[] = [];
    const write = post(server, '/v1/memories', { content: 'behind the lock' }, key.plaintext).then((res) => {
      order.push('write');
      return res;
    });
    await sent('entryWrites.writeEntry', 2);
    const audit = await get(server, '/v1/audit', key.plaintext);
    order.push('audit');
    const keys = await get(server, '/v1/auth/keys', key.plaintext);
    order.push('keys');

    expect([audit.status, keys.status]).toEqual([200, 200]);
    expect(order).toEqual(['audit', 'keys']);
    lock.release();
    expect((await write).status).toBe(200);
    expect(order).toEqual(['audit', 'keys', 'write']);
    expect(contents(root)).toEqual(['behind the lock', 'warms the writer']);
  });
});

describe("a memory write still behind the write lock at its request's deadline", () => {
  it('is stopped before its commit: the 504 says nothing was saved, and no row, audit row or mirror file is left', async () => {
    const root = newRoot();
    const key = keyFor(root, 'default');
    const left = () => [auditRows(root, [key.keyId]), storedRows(root, [key.keyId]), mirrorFiles(root)];
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '0');
    // A grace far past the test's own timeout, so the reply can only be the stopped thread's own word.
    const { store } = patientStore(root, { writeGraceMs: 60_000 });
    const server = await start(root, store);
    expect((await post(server, '/v1/memories', { content: 'warms the writer' }, key.plaintext)).status).toBe(200);
    const before = left();
    const lock = holdWriteLock(root);
    const expired = new Promise<void>((resolve) => {
      vi.spyOn(log, 'warn').mockImplementation((message) => {
        if (message.includes("past its request's deadline")) resolve();
      });
    });

    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '1000');
    const write = post(server, '/v1/memories', { content: 'stopped before its commit' }, key.plaintext);
    await expired;
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '0');
    lock.release();
    const res = await write;

    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'deadline_exceeded', error: expect.stringContaining('nothing was saved') });
    expect(left()).toEqual(before);
    expect((await post(server, '/v1/memories', { content: 'after the replacement' }, key.plaintext)).status).toBe(200);
    expect(contents(root)).toEqual(['after the replacement', 'warms the writer']);
  });
});

interface Seeded {
  readonly memoryId: string;
  readonly keyId: string;
  readonly token: string;
}

type InProcess = HippoStore & StoreGroups;

describe("the server-thread block of a moved `loop: 'off'` route", () => {
  const ROUTES: ReadonlyArray<readonly [route: string, swapped: (inProcess: InProcess) => Partial<InProcess>, send: (server: ServerHandle, seeded: Seeded) => Promise<Response>]> = [
    ['POST /v1/memories', (p) => ({ entryWrites: p.entryWrites }), (s, made) => post(s, '/v1/memories', { content: 'opened on the server thread' }, made.token)],
    ['POST /v1/memories/:id/archive', (p) => ({ entryWrites: p.entryWrites }), (s, made) => post(s, `/v1/memories/${made.memoryId}/archive`, { reason: 'refused' }, made.token)],
    ['POST /v1/memories/:id/supersede', (p) => ({ entryWrites: p.entryWrites }), (s, made) => post(s, `/v1/memories/${made.memoryId}/supersede`, { content: 'refused' }, made.token)],
    ['POST /v1/memories/:id/supersede, by its read of the old row', (p) => ({ entriesByIds: p.entriesByIds }), (s, made) => post(s, `/v1/memories/${made.memoryId}/supersede`, { content: 'refused' }, made.token)],
    ['DELETE /v1/memories/:id', (p) => ({ entryWrites: p.entryWrites }), (s, made) => del(s, `/v1/memories/${made.memoryId}`, made.token)],
    ['GET /v1/sessions/:id/assemble', (p) => ({ dagReads: p.dagReads }), (s, made) => get(s, '/v1/sessions/sess-1/assemble', made.token)],
    ['GET /v1/sessions/:id/assemble, by its token record', (p) => ({ recordTokens: p.recordTokens }), (s, made) => get(s, '/v1/sessions/sess-1/assemble', made.token)],
    ['POST /v1/auth/keys', (p) => ({ keyWrites: p.keyWrites }), (s, made) => post(s, '/v1/auth/keys', { label: 'refused', role: 'member' }, made.token)],
    ['GET /v1/auth/keys', (p) => ({ keyWrites: p.keyWrites }), (s, made) => get(s, '/v1/auth/keys', made.token)],
    ['DELETE /v1/auth/keys/:keyId', (p) => ({ keyAudit: p.keyAudit }), (s, made) => del(s, `/v1/auth/keys/${made.keyId}`, made.token)],
    ['GET /v1/audit', (p) => ({ auditLog: p.auditLog }), (s, made) => get(s, '/v1/audit', made.token)],
    ['GET /v1/audit, by the key row read', (p) => ({ findApiKey: p.findApiKey }), (s, made) => get(s, '/v1/audit', made.token)],
  ];

  it.each(ROUTES)('%s fails when its handler opens hippo.db on the server thread', async (_route, swapped, send) => {
    const root = newRoot();
    const [memoryId = ''] = seedSession(root, 'default', 'sess-1', 1);
    const caller = keyFor(root, 'default');
    const spare = keyFor(root, 'default');
    const before = [auditRows(root, []), storedRows(root, [])];
    const info = vi.spyOn(log, 'info');
    // The worker-backed store with one group or method swapped back to the in-process one: the defect the block exists to catch.
    const store = Object.assign(workerSqliteStore(root), swapped(sqliteStore(root)));
    const server = await start(root, store);

    const res = await send(server, { memoryId, keyId: spare.keyId, token: caller.plaintext });

    expect(res.status).toBe(501);
    expect(info.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('opened on the server thread by a route'))).toHaveLength(1);
    expect([auditRows(root, []), storedRows(root, [])]).toEqual(before);
  });
});

/** `inner`, with each key row read answered only once `count` of them wait, so every check reaches the bounds before any derivation can end. */
function keyReadsTogether(inner: SqliteExecutor, count: number): SqliteExecutor {
  const held: Array<() => void> = [];
  let open = false;
  return {
    call: async <T>(...sent: Parameters<SqliteExecutor['call']>) => {
      const value = await inner.call<T>(...sent);
      if (sent[0] !== KEY_READ || open) return value;
      await new Promise<void>((resolve) => {
        held.push(resolve);
        if (held.length < count) return;
        open = true;
        for (const release of held.splice(0)) release();
      });
      return value;
    },
    close: () => inner.close(),
    liveThreads: () => inner.liveThreads(),
    terminateWriter: () => inner.terminateWriter(),
  };
}

describe('a 429 and the store workers', () => {
  it('refuses a request over the per-address limit before any call reaches a worker', async () => {
    const root = newRoot();
    const key = keyFor(root, 'default');
    const { store, ops } = patientStore(root);
    const server = await start(root, store, { rateLimits: { perAddress: { ratePerSec: 0.001, burst: 1 } } });
    expect((await get(server, '/v1/audit', key.plaintext)).status).toBe(200);
    const answered = [...ops];

    const refused = await get(server, '/v1/audit', key.plaintext);

    expect([refused.status, await refused.text()]).toEqual([429, '{"error":"rate limit exceeded"}']);
    expect(answered).toEqual([KEY_READ, 'auditLog.listAuditEvents']);
    expect(ops).toEqual(answered);
  });

  it("refuses an address its sixth wrong secret for one key id after that key's row read and no other worker call", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T09:00:00Z'));
    const root = newRoot();
    const key = keyFor(root, 'default');
    const { store, ops } = patientStore(root);
    const server = await start(root, store);
    const wrong = (n: number): string => `${key.keyId}.${'abcdefghijklmnopqrstuvwxyz'.charAt(n).repeat(32)}`;

    const replies = [];
    for (let n = 0; n < 7; n++) {
      const res = await get(server, '/v1/audit', wrong(n));
      replies.push([res.status, await res.text()]);
    }

    expect(replies.slice(0, 5)).toEqual(Array(5).fill([401, '{"error":"invalid api key"}']));
    expect(replies.slice(5)).toEqual(Array(2).fill([429, '{"error":"too many key checks from this address"}']));
    expect(ops).toEqual(Array(7).fill(KEY_READ));
  });

  it('refuses the key checks past two running and eight waiting after their key row reads and no other worker call', async () => {
    const root = newRoot();
    const keys = Array.from({ length: 13 }, () => keyFor(root, 'default'));
    const { executor, ops } = watched(keyReadsTogether(createSqliteExecutor(root), keys.length));
    const server = await start(root, workerSqliteStore(root, executor));

    const replies = await Promise.all(keys.map(async (key) => {
      const res = await get(server, '/v1/audit', key.plaintext);
      return res.ok ? 200 : `${res.status} ${await res.text()}`;
    }));

    expect(replies.filter((reply) => reply === 200)).toHaveLength(10);
    expect(replies.filter((reply) => reply !== 200)).toEqual(Array(3).fill('429 {"error":"rate limit exceeded"}'));
    expect(ops.filter((op) => op === KEY_READ)).toHaveLength(13);
    expect(ops.filter((op) => op !== KEY_READ)).toEqual(Array(10).fill('auditLog.listAuditEvents'));
  });
});

describe('an audit write failure counted on a worker thread', () => {
  it('reaches /health when the write was refused and its refusal row could not be written', async () => {
    const root = newRoot();
    rejectValue(root, 'default', REFUSED);
    const server = await start(root);
    const before = await auditFailures(server);
    execOn(root, `CREATE TRIGGER refusal_audit_broken BEFORE INSERT ON audit_log WHEN NEW.op = 'reject_refusal' BEGIN SELECT RAISE(ABORT, 'audit table unwritable'); END`);

    const res = await post(server, '/v1/memories', { content: REFUSED });

    expect(res.status).toBe(400);
    expect(await auditFailures(server)).toBe(before + 1);
    expect(contents(root)).toEqual([]);
  });
});

/** Predictions in hippo.db's main file alone, which holds only what a checkpoint has copied out of the WAL. */
function checkpointedPredictions(root: string): number {
  const copy = removeLater(mkdtempSync(join(tmpdir(), 'hippo-sqlite-executor-main-file-')));
  copyFileSync(getHippoDbPath(root), getHippoDbPath(copy));
  return onDb(copy, (db) => db.prepare('SELECT COUNT(*) AS n FROM predictions').get<{ n: number }>().n);
}

describe("a store worker's wal_autocheckpoint", () => {
  it('follows the server thread: no checkpoint inside a commit while the checkpointer runs, and one in the next commit after it stops', async () => {
    const root = newRoot();
    const checkpointer = startWalCheckpointer(getHippoDbPath(root));
    cleanups.push(() => checkpointer.stop());
    const store = workerSqliteStore(root);
    cleanups.push(() => store.close());
    const save = (n: number) => {
      const saved = { classTag: 'release', claimText: `claim ${n}` };
      return store.predictions.savePrediction('default', { ...saved, mirror: predictionMirror('default', saved, 30) }, 'test');
    };

    for (let n = 0; n < 60; n++) await save(n);
    // Past the 100 pages at which a connection of this thread's own would have checkpointed inside its commit.
    expect(statSync(`${getHippoDbPath(root)}-wal`).size).toBeGreaterThan(150 * 4096);
    expect(checkpointedPredictions(root)).toBe(0);

    await checkpointer.stop();
    await save(60);

    expect(checkpointedPredictions(root)).toBe(61);
  });
});
