// With ctx.store, remember, outcome, supersede, archiveRaw and forget write through its entryWrites group and never open hippo.db;
// their routes and the hippo_remember and hippo_outcome tools run under another store only when it has the group.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  archiveRaw, forget, outcome, outcomeForLastRecall, remember, supersede, type Actor, type ArchiveRawResult, type Context, type ForgetResult,
  type HippoDbContext, type OutcomeResult, type RememberResult, type SupersedeResult,
} from '../src/api/index.js';
import { closeHippoDb, openHippoDb, withSqliteBlocked } from '../src/db/index.js';
import { SqliteBlockedError, StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { STORE_NOT_PORTED_MESSAGE } from '../src/util/http-util.js';
import { handleMcpRequest, type McpContext } from '../src/mcp/server.js';
import { lastRecalledIds, resolveClientKey } from '../src/mcp/session-state.js';
import { OTHER_STORE_MARKER, serve, type HippoStore, type ServerHandle } from '../src/server.js';
import { inMemoryEntryWritesStore } from './_helpers/in-memory-entry-writes-store.js';
import { portOnlyStoreWithoutVectorReads } from './_helpers/port-only-store.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:00.000Z';
const admin: Actor = { subject: 'cli', role: 'admin' };
let fixture: TwoTenantFixture;
let home: string;
let n = 0;

function copyOf(): string {
  const root = join(home, `copy-${++n}`);
  cpSync(fixture.dir, root, { recursive: true });
  return root;
}

/** A folder whose marker names another store, so a hippo.db open in it throws and creates nothing. */
function markedFolder(): string {
  const root = join(home, `marked-${++n}`);
  mkdirSync(root);
  writeFileSync(join(root, OTHER_STORE_MARKER), 'in-memory\n');
  return root;
}

function auditIdsOnHippoDb(root: string): number[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names one column, id.
    return (db.prepare('SELECT id FROM audit_log ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  } finally {
    closeHippoDb(db);
  }
}

beforeAll(() => {
  fixture = seedTwoTenants();
  home = mkdtempSync(join(tmpdir(), 'hippo-entry-writes-store-'));
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('the api with ctx.store', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes through entryWrites with hippo.db blocked, and creates no hippo.db in hippoRoot', async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryEntryWritesStore(copyOf());
    const ctx = { hippoRoot, tenantId: TENANT_A, actor: admin, store: memory.store };
    await withSqliteBlocked('in-memory', async () => {
      const raw = await remember(ctx, { content: 'raw call transcript about the outage', kind: 'raw' });
      const note = await remember(ctx, { content: 'deploys go out on tuesdays' });
      expect(await outcome(ctx, [note.id, 'mem_missing'], true)).toEqual({ applied: 1, appliedIds: [note.id] });
      const { newId } = await supersede(ctx, note.id, 'deploys go out on wednesdays');
      expect(await archiveRaw(ctx, raw.id, 'source deleted')).toEqual({ ok: true, archivedAt: NOW });
      expect(await forget(ctx, newId)).toEqual({ ok: true, id: newId });
      const rows = await memory.store.entriesByIds([note.id, newId, raw.id], TENANT_A);
      expect(rows.map((r) => [r.id, r.superseded_by, r.outcome_positive])).toEqual([[note.id, newId, 1]]);
    });
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(memory.forgotten()).toBe(2);
    const ops = memory.auditRows().filter((r) => r.ts === NOW).map((r) => r.op);
    expect(ops).toEqual(['remember', 'remember', 'remember', 'outcome', 'remember', 'supersede', 'archive_raw', 'forget']);
  });

  it("rejects with StoreNotPortedError on a store without entryWrites, and leaves the store's hippo.db alone", async () => {
    const storeRoot = copyOf();
    const before = auditIdsOnHippoDb(storeRoot);
    const ctx = { hippoRoot: markedFolder(), tenantId: TENANT_A, actor: admin, store: portOnlyStoreWithoutVectorReads(storeRoot) };
    const calls = [
      () => remember(ctx, { content: 'deploys go out on tuesdays' }), () => outcome(ctx, ['mem_x'], true), () => supersede(ctx, 'mem_x', 'new text'),
      () => archiveRaw(ctx, 'mem_x', 'r'), () => forget(ctx, 'mem_x'),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow(new StoreNotPortedError('port-only', 'entryWrites'));
    expect(auditIdsOnHippoDb(storeRoot)).toEqual(before);
  });

  it("refuses a connector write, the trace link and the last-recall outcome under a store without connectorWrites", async () => {
    const ctx = { hippoRoot: markedFolder(), tenantId: TENANT_A, actor: admin, store: inMemoryEntryWritesStore(copyOf()).store };
    const noGroup = new StoreNotPortedError('in-memory', 'connectorWrites');
    await expect(remember(ctx, { content: 'connector text', untrusted: true })).rejects.toThrow(noGroup);
    await expect(outcome(ctx, ['mem_x'], true, { traceId: 1 })).rejects.toThrow('links its recall trace on hippo.db only');
    await expect(archiveRaw(ctx, 'mem_x', 'r', { event: { connector: 'slack', eventId: 'Ev_x' } })).rejects.toThrow(noGroup);
    await expect(outcomeForLastRecall(ctx, true)).rejects.toThrow(SqliteBlockedError);
  });

  it('stays synchronous for a ctx with no store', () => {
    expectTypeOf(remember<HippoDbContext>).returns.toEqualTypeOf<RememberResult>();
    expectTypeOf(remember<Context & { store: HippoStore }>).returns.toEqualTypeOf<Promise<RememberResult>>();
    expectTypeOf(remember<Context>).returns.toEqualTypeOf<RememberResult | Promise<RememberResult>>();
  });
});

/** The request body fields the entry write routes read. */
interface RouteBody {
  readonly content?: string;
  readonly kind?: string;
  readonly reason?: string;
  readonly ids?: readonly string[];
  readonly good?: boolean;
}

describe('the entry write routes', () => {
  let handle: ServerHandle | undefined;
  const send = (path: string, method: string, token: string, body?: RouteBody): Promise<Response> => fetch(`${handle?.url}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = async <T>(res: Promise<Response>): Promise<T> => {
    const reply = await res;
    expect(reply.status).toBe(200);
    // SAFETY: the caller names the reply its route answers with.
    return reply.json() as Promise<T>;
  };

  beforeEach(() => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    vi.unstubAllEnvs();
  });

  it('answer 501 before the handler on a store without entryWrites, and a bad key is still a 401', async () => {
    const root = copyOf();
    const before = auditIdsOnHippoDb(root);
    handle = await serve({ hippoRoot: root, port: 0, store: portOnlyStoreWithoutVectorReads(root) });
    const token = fixture.tokens.adminA;
    const replies = await Promise.all([
      send('/v1/memories', 'POST', token, { content: 'deploys go out on tuesdays' }), send('/v1/memories/mem_x/archive', 'POST', token, { reason: 'r' }),
      send('/v1/memories/mem_x/supersede', 'POST', token, { content: 'new text' }), send('/v1/memories/mem_x', 'DELETE', token),
      send('/v1/outcome', 'POST', token, { ids: ['mem_x'], good: true }),
    ]);
    for (const res of replies) expect({ status: res.status, body: await res.json() }).toEqual({ status: 501, body: { error: STORE_NOT_PORTED_MESSAGE } });
    expect((await send('/v1/memories', 'POST', `${token}.wrong`, { content: 'x' })).status).toBe(401);
    expect(auditIdsOnHippoDb(root)).toEqual(before);
  });

  it('serve every entry write through the store that has entryWrites; the last-recall outcome stays 501', async () => {
    const root = copyOf();
    const before = auditIdsOnHippoDb(root);
    const memory = inMemoryEntryWritesStore(root);
    handle = await serve({ hippoRoot: root, port: 0, store: memory.store });
    const token = fixture.tokens.adminA;
    const note = await json<RememberResult>(send('/v1/memories', 'POST', token, { content: 'deploys go out on tuesdays' }));
    const raw = await json<RememberResult>(send('/v1/memories', 'POST', token, { content: 'raw call transcript', kind: 'raw' }));
    expect(await json<Pick<OutcomeResult, 'applied'>>(send('/v1/outcome', 'POST', token, { ids: [note.id], good: true }))).toEqual({ applied: 1 });
    const lastRecall = await send('/v1/outcome', 'POST', token, { good: true });
    expect({ status: lastRecall.status, body: await lastRecall.json() }).toEqual({
      status: 501, body: { error: 'this store keeps no last recall: send the ids your recall returned' },
    });
    const { newId } = await json<SupersedeResult>(send(`/v1/memories/${note.id}/supersede`, 'POST', token, { content: 'deploys go out on wednesdays' }));
    expect(await json<ArchiveRawResult>(send(`/v1/memories/${raw.id}/archive`, 'POST', token, { reason: 'source deleted' }))).toMatchObject({ ok: true });
    expect(await json<ForgetResult>(send(`/v1/memories/${newId}`, 'DELETE', token))).toEqual({ ok: true, id: newId });
    expect(memory.auditRows().slice(-4).map((r) => [r.op, r.actor])).toEqual([
      ['remember', `api_key:${fixture.keys.adminA}`], ['supersede', `api_key:${fixture.keys.adminA}`],
      ['archive_raw', `api_key:${fixture.keys.adminA}`], ['forget', `api_key:${fixture.keys.adminA}`],
    ]);
    expect(auditIdsOnHippoDb(root)).toEqual(before);
  });

  it("write and remove the markdown mirrors on serve()'s default hippo.db store", async () => {
    const root = copyOf();
    handle = await serve({ hippoRoot: root, port: 0 });
    const token = fixture.tokens.adminA;
    const mirror = (id: string): boolean => existsSync(join(root, 'episodic', `${id}.md`));
    const note = await json<RememberResult>(send('/v1/memories', 'POST', token, { content: 'deploys go out on tuesdays' }));
    expect(mirror(note.id)).toBe(true);
    const { newId } = await json<SupersedeResult>(send(`/v1/memories/${note.id}/supersede`, 'POST', token, { content: 'deploys go out on wednesdays' }));
    expect(mirror(newId)).toBe(true);
    expect(await json<ForgetResult>(send(`/v1/memories/${newId}`, 'DELETE', token))).toEqual({ ok: true, id: newId });
    expect(mirror(newId)).toBe(false);
  });
});

describe('hippo_remember and hippo_outcome under another store', () => {
  it('remember and apply an outcome through the store, with hippo.db blocked', async () => {
    const hippoRoot = markedFolder();
    const memory = inMemoryEntryWritesStore(copyOf());
    const ctx: McpContext = { hippoRoot, tenantId: TENANT_A, actor: 'mcp', store: memory.store, clientKey: 'entry-writes-store' };
    const call = (name: string, args: Record<string, string | boolean>) => withSqliteBlocked('in-memory', () =>
      handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx));
    const textOf = (res: Awaited<ReturnType<typeof call>>): string | undefined =>
      // SAFETY: a tools/call reply carries { content: [{ type: 'text', text }] }.
      (res?.result as { content: { text: string }[] } | undefined)?.content[0]?.text;
    const remembered = textOf(await call('hippo_remember', { text: 'deploys go out on tuesdays', tag: 'deploy' }));
    const id = /^Remembered \[(\w+)\] \(half-life: \d+d, tags: deploy\)$/.exec(remembered ?? '')?.[1];
    expect(id).toBeDefined();
    lastRecalledIds.set(resolveClientKey(ctx), [id ?? '']);
    expect(textOf(await call('hippo_outcome', { good: true }))).toBe('Applied positive outcome to 1 memories');
    expect((await memory.store.entriesByIds([id ?? ''], TENANT_A)).map((r) => r.outcome_positive)).toEqual([1]);
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
  });
});
