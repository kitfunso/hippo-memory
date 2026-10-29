// Quarantine as one feature on hippo.db's local tier: its routes answer from worker threads, under
// the request's deadline, within the caller's tenant, and refuse once on a store without the tier.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { closeHippoDb, getHippoDbPath, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { serve } from '../../src/server.js';
import type { HippoStore } from '../../src/base/ports/store.js';
import { createSqliteExecutor } from '../../src/store/sqlite/runtime/executor.js';
import { workerSqliteStore } from '../../src/store/sqlite/runtime/worker-store.js';
import { auditRowsOn } from '../_helpers/audit-rows.js';
import { HELD, heldAt, heldContent, seedQuarantineRecords } from '../_helpers/quarantine-seed.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { recordingExecutor } from '../_helpers/recording-executor.js';
import { seedTwoTenants, TENANT_A, type TwoTenantFixture } from '../_helpers/store-conformance.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

// Far past the test's own timeout, so a write behind the held lock ends only when the test releases it.
const LONG_WAIT_MS = 60_000;
const SHORT_DEADLINE_MS = '400';
const APPROVE = 'hippoDb.quarantine.approve';

let fixture: TwoTenantFixture;
let adminB: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  vi.stubEnv('HIPPO_V1_RPS', '0');
  vi.stubEnv('HIPPO_CALLER_RPS', '0');
  vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '0');
  fixture = seedTwoTenants();
  adminB = seedQuarantineRecords(fixture.dir);
});

afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
  vi.unstubAllEnvs();
  rmSync(fixture.dir, { recursive: true, force: true });
});

/** serve() on `store`, with a sender that names the caller's bearer token. */
async function served(store: HippoStore) {
  const handle = await serve({ hippoRoot: fixture.dir, port: 0, store });
  cleanups.push(async () => {
    await handle.stop();
    await store.close();
  });
  return async (token: string, method: string, path: string, body: JsonValue = {}) => {
    const res = await fetch(`${handle.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
}

/** The ids a GET /v1/quarantine reply lists. */
const listedIds = (text: string): string[] => [...text.matchAll(/"id":"(mem_\w+)"/g)].map((m) => m[1] ?? '');

/** Every audit row hippo.db holds, oldest first. */
function auditRows() {
  const db = openHippoDb(fixture.dir);
  try {
    return auditRowsOn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** A second connection, as another process would hold, with the write lock taken until `release`. */
function holdWriteLock() {
  const other = new DatabaseSync(getHippoDbPath(fixture.dir));
  cleanups.push(() => {
    if (other.isOpen !== false) other.close();
  });
  other.exec('BEGIN IMMEDIATE');
  return { release: () => other.exec('COMMIT') };
}

describe("quarantine on hippo.db's local tier", () => {
  it('lists, approves and rejects from worker threads, each as a local op', async () => {
    const { executor, sent } = recordingExecutor(createSqliteExecutor(fixture.dir));
    const send = await served(workerSqliteStore(fixture.dir, executor));
    const admin = fixture.tokens.adminA;
    expect((await send(admin, 'GET', '/v1/quarantine')).status).toBe(200);
    expect((await send(admin, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).status).toBe(200);
    expect((await send(admin, 'POST', `/v1/quarantine/${HELD.a3}/reject`)).status).toBe(200);
    const local = sent.filter(({ op }) => op.includes('quarantine')).map(({ op, mode }) => `${op} ${mode}`);
    expect(local).toEqual([
      'hippoDb.quarantine.list read',
      'hippoDb.quarantine.approve write',
      'hippoDb.quarantine.reject write',
    ]);
  });

  it("lists and decides only within the caller's tenant, with each reply's body", async () => {
    const send = await served(workerSqliteStore(fixture.dir));
    const call = async (token: string, method: string, path: string) => {
      const { status, text } = await send(token, method, path);
      return { status, body: JSON.parse(text) };
    };
    const { adminA, memberA } = fixture.tokens;
    const item = (id: string, originalScope: string | null, second: number) => ({
      id,
      originalScope,
      reason: 'test',
      status: 'pending',
      quarantinedAt: heldAt(second),
      decidedAt: null,
      decidedBy: null,
      contentPreview: heldContent(id),
    });
    expect(await call(adminA, 'GET', '/v1/quarantine')).toEqual({
      status: 200,
      body: {
        quarantine: [
          item(HELD.moved, 'team:alpha', 4),
          item(HELD.a3, 'team:alpha', 2),
          item(HELD.a2, null, 2),
          item(HELD.a1, 'team:alpha', 1),
        ],
        next_cursor: null,
      },
    });
    expect(listedIds((await send(adminB, 'GET', '/v1/quarantine')).text)).toEqual([HELD.b1]);
    expect((await call(memberA, 'GET', '/v1/quarantine')).status).toBe(403);
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).toEqual({
      status: 200,
      body: { approved: HELD.a1 },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a1}/approve`)).toEqual({
      status: 409,
      body: { error: `${HELD.a1} is already approved` },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.moved}/approve`)).toEqual({
      status: 409,
      body: { error: `memory ${HELD.moved} scope changed since quarantine; refusing to approve` },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a2}/reject`)).toEqual({
      status: 200,
      body: { rejected: HELD.a2 },
    });
    expect(await call(adminA, 'POST', `/v1/quarantine/${HELD.a2}/reject`)).toEqual({
      status: 409,
      body: { error: `${HELD.a2} is already rejected` },
    });
    for (const verb of ['approve', 'reject']) {
      expect(await call(adminB, 'POST', `/v1/quarantine/${HELD.a3}/${verb}`)).toEqual({
        status: 404,
        body: { error: `not quarantined: ${HELD.a3}` },
      });
    }
    expect(await call(adminA, 'GET', '/v1/quarantine?status=all&limit=2')).toMatchObject({
      status: 200,
      body: {
        quarantine: [
          { id: HELD.moved, status: 'pending' },
          { id: HELD.gone, contentPreview: '' },
        ],
        next_cursor: expect.any(String),
      },
    });
    expect(await call(adminA, 'GET', '/v1/quarantine?status=maybe')).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/status must be one of: pending/) },
    });
    expect(await call(adminA, 'GET', '/v1/quarantine?status=approved')).toMatchObject({
      status: 200,
      body: {
        quarantine: [{ id: HELD.a1, status: 'approved', decidedBy: `api_key:${fixture.keys.adminA}` }],
        next_cursor: null,
      },
    });
    const actor = `api_key:${fixture.keys.adminA}`;
    expect(
      auditRows()
        .slice(-2)
        .map((e) => [e.op, e.actor, e.tenantId, e.targetId]),
    ).toEqual([
      ['quarantine_approve', actor, TENANT_A, HELD.a1],
      ['quarantine_reject', actor, TENANT_A, HELD.a2],
    ]);
  });

  it("drops a decision still waiting for the writer at its request's deadline, and it never runs", async () => {
    const patient = createSqliteExecutor(fixture.dir, { busyWaitMs: LONG_WAIT_MS });
    const { executor, handed } = recordingExecutor(patient);
    const send = await served(workerSqliteStore(fixture.dir, executor));
    const admin = fixture.tokens.adminA;
    // Starts the writer thread, so the held lock below stops only the two decisions.
    expect((await send(admin, 'POST', `/v1/quarantine/${HELD.a1}/reject`)).status).toBe(200);
    const lock = holdWriteLock();
    const running = send(admin, 'POST', `/v1/quarantine/${HELD.a2}/approve`);
    await handed(APPROVE, 1);
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', SHORT_DEADLINE_MS);
    const waited = await send(admin, 'POST', `/v1/quarantine/${HELD.a3}/approve`);
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '0');
    expect(waited.status).toBe(503);
    lock.release();
    expect((await running).status).toBe(200);
    const pending = await send(admin, 'GET', '/v1/quarantine');
    expect(listedIds(pending.text)).toContain(HELD.a3);
    expect(listedIds(pending.text)).not.toContain(HELD.a2);
  }, 20_000);

  it('answers the one refusal on every quarantine route of a store without the tier', async () => {
    const send = await served(portOnlyStore(fixture.dir));
    const admin = fixture.tokens.adminA;
    for (const [method, path] of [
      ['GET', '/v1/quarantine'],
      ['POST', `/v1/quarantine/${HELD.a1}/approve`],
      ['POST', `/v1/quarantine/${HELD.a1}/reject`],
    ] as const) {
      const { status, text } = await send(admin, method, path);
      expect({ path, status, body: JSON.parse(text) }).toEqual({
        path,
        status: 501,
        body: { error: STORE_NOT_PORTED_MESSAGE },
      });
    }
  });
});
