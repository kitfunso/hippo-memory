// With ctx.store, remember, outcome, supersede, rawArchive and forget write through its entryWrites group and never open hippo.db;
// their routes and the hippo_remember and hippo_outcome tools run under another store only when it has the group.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rawArchive,
  forget,
  outcome,
  remember,
  supersede,
  type Actor,
  type ArchiveRawResult,
  type ForgetResult,
  type OutcomeResult,
  type RememberResult,
  type SupersedeResult,
} from '../../src/api/index.js';
import { closeHippoDb, openHippoDb, withSqliteBlocked } from '../../src/db/index.js';
import { handleMcpRequest, type McpContext } from '../../src/surface/mcp/server.js';
import { resolveClientKey } from '../../src/api/recall/last-recalled.js';
import { createCallerState } from '../../src/api/callers.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { OTHER_STORE_MARKER } from '../../src/entry/store-kit.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';
import { loadConfig } from '../../src/host/config-file.js';
import { memorySide } from '../_helpers/memory-side.js';
import { testInfra } from '../_helpers/infra.js';

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
    const memory = memorySide(copyOf());
    const ctx = {
      hippoRoot,
      tenantId: TENANT_A,
      actor: admin,
      store: memory.store,
      config: loadConfig(hippoRoot),
      infra: testInfra(),
    };
    await withSqliteBlocked('in-memory', async () => {
      const raw = await remember(ctx, { content: 'raw call transcript about the outage', kind: 'raw' });
      const note = await remember(ctx, { content: 'deploys go out on tuesdays' });
      expect(await outcome(ctx, [note.id, 'mem_missing'], true)).toEqual({ applied: 1, appliedIds: [note.id] });
      const { newId } = await supersede(ctx, note.id, 'deploys go out on wednesdays');
      expect(await rawArchive(ctx, raw.id, 'source deleted')).toEqual({ ok: true, archivedAt: NOW });
      expect(await forget(ctx, newId)).toEqual({ ok: true, id: newId });
      const rows = await memory.store.entriesByIds([note.id, newId, raw.id], TENANT_A);
      expect(rows.map((r) => [r.id, r.supersededBy, r.outcomePositive])).toEqual([[note.id, newId, 1]]);
    });
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
    expect(memory.forgotten()).toBe(2);
    const ops = memory
      .auditRows()
      .filter((r) => r.ts === NOW)
      .map((r) => r.op);
    expect(ops).toEqual([
      'remember',
      'remember',
      'remember',
      'outcome',
      'remember',
      'supersede',
      'archive_raw',
      'forget',
    ]);
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
  const send = (path: string, method: string, token: string, body?: RouteBody): Promise<Response> =>
    fetch(`${handle?.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
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

  it('serve every entry write through the store that has entryWrites; a no-ids outcome needs no last recall', async () => {
    const root = copyOf();
    const before = auditIdsOnHippoDb(root);
    const memory = memorySide(root);
    handle = await serve({ hippoRoot: root, port: 0, store: memory.store });
    const token = fixture.tokens.adminA;
    const note = await json<RememberResult>(
      send('/v1/memories', 'POST', token, { content: 'deploys go out on tuesdays' }),
    );
    const raw = await json<RememberResult>(
      send('/v1/memories', 'POST', token, { content: 'raw call transcript', kind: 'raw' }),
    );
    expect(
      await json<Pick<OutcomeResult, 'applied'>>(send('/v1/outcome', 'POST', token, { ids: [note.id], good: true })),
    ).toEqual({ applied: 1 });
    // It lands on this client's own last REST recall, which the server holds, and this client has recalled nothing.
    expect(await json<{ applied: number; ids: string[] }>(send('/v1/outcome', 'POST', token, { good: true }))).toEqual({
      applied: 0,
      ids: [],
    });
    const { newId } = await json<SupersedeResult>(
      send(`/v1/memories/${note.id}/supersede`, 'POST', token, { content: 'deploys go out on wednesdays' }),
    );
    expect(
      await json<ArchiveRawResult>(send(`/v1/memories/${raw.id}/archive`, 'POST', token, { reason: 'source deleted' })),
    ).toMatchObject({ ok: true });
    expect(await json<ForgetResult>(send(`/v1/memories/${newId}`, 'DELETE', token))).toEqual({ ok: true, id: newId });
    expect(
      memory
        .auditRows()
        .slice(-4)
        .map((r) => [r.op, r.actor]),
    ).toEqual([
      ['remember', `api_key:${fixture.keys.adminA}`],
      ['supersede', `api_key:${fixture.keys.adminA}`],
      ['archive_raw', `api_key:${fixture.keys.adminA}`],
      ['forget', `api_key:${fixture.keys.adminA}`],
    ]);
    expect(auditIdsOnHippoDb(root)).toEqual(before);
  });

  it("write and remove the markdown mirrors on serve()'s default hippo.db store", async () => {
    const root = copyOf();
    handle = await serve({ hippoRoot: root, port: 0 });
    const token = fixture.tokens.adminA;
    const mirror = (id: string): boolean => existsSync(join(root, 'episodic', `${id}.md`));
    const note = await json<RememberResult>(
      send('/v1/memories', 'POST', token, { content: 'deploys go out on tuesdays' }),
    );
    expect(mirror(note.id)).toBe(true);
    const { newId } = await json<SupersedeResult>(
      send(`/v1/memories/${note.id}/supersede`, 'POST', token, { content: 'deploys go out on wednesdays' }),
    );
    expect(mirror(newId)).toBe(true);
    expect(await json<ForgetResult>(send(`/v1/memories/${newId}`, 'DELETE', token))).toEqual({ ok: true, id: newId });
    expect(mirror(newId)).toBe(false);
  });
});

describe('hippo_remember and hippo_outcome under another store', () => {
  it('remember and apply an outcome through the store, with hippo.db blocked', async () => {
    const hippoRoot = markedFolder();
    const memory = memorySide(copyOf());
    const callers = createCallerState();
    const ctx: McpContext = {
      hippoRoot,
      tenantId: TENANT_A,
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      store: memory.store,
      clientKey: 'entry-writes-store',
      config: loadConfig(hippoRoot),
      infra: testInfra(),
      callers,
    };
    const call = (name: string, args: Record<string, string | boolean>) =>
      withSqliteBlocked('in-memory', () =>
        handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx),
      );
    const textOf = (res: Awaited<ReturnType<typeof call>>): string | undefined =>
      // SAFETY: a tools/call reply carries { content: [{ type: 'text', text }] }.
      (res?.result as { content: { text: string }[] } | undefined)?.content[0]?.text;
    const remembered = textOf(await call('hippo_remember', { text: 'deploys go out on tuesdays', tag: 'deploy' }));
    const id = /^Remembered \[(\w+)\] \(half-life: \d+d, tags: deploy\)$/.exec(remembered ?? '')?.[1];
    expect(id).toMatch(/^mem_[0-9a-f]+$/);
    callers.lastShown.set(resolveClientKey(ctx), [id ?? '']);
    expect(textOf(await call('hippo_outcome', { good: true }))).toBe('Applied positive outcome to 1 memories');
    expect((await memory.store.entriesByIds([id ?? ''], TENANT_A)).map((r) => r.outcomePositive)).toEqual([1]);
    expect(readdirSync(hippoRoot)).toEqual([OTHER_STORE_MARKER]);
  });
});
