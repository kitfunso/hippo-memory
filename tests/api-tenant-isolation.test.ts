import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { readEntry } from '../src/store/entry-reads.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import { createApiKey } from '../src/store/auth.js';
import { queryAuditEvents } from '../src/store/audit.js';
import {
  remember,
  promote,
  supersede,
  type HippoDbContext,
} from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

// SAFETY: node:sqlite's DatabaseSync is the class db.ts wraps as DatabaseSyncLike.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: { prototype: DatabaseSyncLike } };

/**
 * Typed wrapper around a single-row SQL lookup. Every call site below
 * passes a SELECT whose column list matches T exactly, so the cast is sound.
 */
function queryRow<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: each call site's SELECT explicitly lists the columns matching T.
  return db.prepare(sql).get(...params) as T | undefined;
}

// v0.39 commit 1 regressions:
//  - promote: tenant pre-check matches archiveRaw (CRITICAL #1)
//  - authCreate: HTTP body.tenantId ignored, key bound to caller (CRITICAL #2)
//  - supersede: BEGIN IMMEDIATE CAS: two-connection race + clean path + tenant scope
//    (CRITICAL #4)

describe('api tenant isolation', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('v039');
    globalHome = makeRoot('v039-global');
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
    try { rmSync(globalHome, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  // ---- Test 1: promote cross-tenant denied ----------------------------------
  it('promote refuses to promote a row that belongs to another tenant', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: { subject: 'cli', role: 'admin' } },
      { content: 'alpha-row promote-cross-tenant canary' },
    );

    expect(() =>
      promote(
        { hippoRoot: home, tenantId: 'bravo', actor: { subject: 'api_key:bravo-key', role: 'admin' } },
        created.id,
      ),
    ).toThrow(/memory not found/i);

    // The original row must still exist on the local root, untouched.
    const db = openHippoDb(home);
    try {
      const row = queryRow<{ tenant_id: string }>(db, `SELECT tenant_id FROM memories WHERE id = ?`, created.id);
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db);
    }

    // The global root must NOT have a copy. promoteToGlobal must never have
    // run because the tenant pre-check throws before it does.
    const gdb = openHippoDb(globalHome);
    try {
      const grows = queryRow<{ c: number }>(gdb, `SELECT COUNT(*) AS c FROM memories`)!;
      expect(Number(grows.c)).toBe(0);
    } finally {
      closeHippoDb(gdb);
    }
  });

  // The loser read the row before the winner committed, so its early check passed: only the guarded UPDATE can refuse it.
  it('supersede refuses the writer that read the row before another connection superseded it', () => {
    const alpha = (): HippoDbContext => ({ hippoRoot: home, tenantId: 'alpha', actor: { subject: 'cli', role: 'admin' } });
    const created = remember(alpha(), { content: 'alpha-row supersede CAS race canary' });

    const winners: string[] = [];
    let raced = false;
    const { exec } = DatabaseSync.prototype;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSyncLike, sql: string) {
      // The loser's first lock request: the winner runs to its commit on its own connection, then the loser goes on.
      if (sql === 'BEGIN IMMEDIATE' && !raced) {
        raced = true;
        winners.push(supersede(alpha(), created.id, 'the winner').newId);
      }
      exec.call(this, sql);
    });
    expect(() => supersede(alpha(), created.id, 'the loser')).toThrow(`Memory ${created.id} already superseded by another writer`);
    vi.restoreAllMocks();

    expect(winners).toHaveLength(1);
    const db = openHippoDb(home);
    try {
      const old = queryRow<{ superseded_by: string | null }>(db, `SELECT superseded_by FROM memories WHERE id = ?`, created.id);
      expect(old?.superseded_by).toBe(winners[0]);
      // The loser's transaction rolled back whole: no successor row and no supersede row of its own.
      const rows = queryRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM memories WHERE tenant_id = 'alpha'`);
      expect(Number(rows?.c)).toBe(2);
      expect(queryAuditEvents(db, { tenantId: 'alpha', op: 'supersede' }).map((e) => e.targetId)).toEqual([created.id]);
    } finally {
      closeHippoDb(db);
    }
    expect(() => supersede(alpha(), created.id, 'a later writer')).toThrow(`is already superseded by ${winners[0]}`);
  });

  // ---- Test 6: supersede CAS — clean path -----------------------------------
  it('supersede CAS clean path: both rows present, audit row written, chain pointer set', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: { subject: 'cli', role: 'admin' } },
      { content: 'alpha-row supersede clean-path canary' },
    );

    const result = supersede(
      { hippoRoot: home, tenantId: 'alpha', actor: { subject: 'cli', role: 'admin' } },
      created.id,
      'fresh replacement content',
    );

    expect(result.ok).toBe(true);
    expect(result.oldId).toBe(created.id);
    expect(result.newId).toMatch(/^mem_/);

    // Old row carries the chain pointer.
    const oldEntry = readEntry(home, created.id, 'alpha');
    expect(oldEntry).not.toBeNull();
    expect(oldEntry!.superseded_by).toBe(result.newId);

    // New row landed.
    const newEntry = readEntry(home, result.newId, 'alpha');
    expect(newEntry).not.toBeNull();
    expect(newEntry!.content).toBe('fresh replacement content');
    expect(newEntry!.tenantId).toBe('alpha');

    // Audit log: 'supersede' op with newId metadata + 'remember' for the new row.
    const db = openHippoDb(home);
    try {
      const supersedeEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'supersede' });
      const supersedeRow = supersedeEvents.find((e) => e.targetId === created.id);
      expect(supersedeRow).toBeDefined();
      // SAFETY: supersede() writes its audit_log row with metadata={ newId }
      // (see api.ts supersede()), so newId is present on this row.
      expect((supersedeRow!.metadata as { newId?: string }).newId).toBe(result.newId);

      const rememberEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'remember' });
      const rememberRow = rememberEvents.find((e) => e.targetId === result.newId);
      expect(rememberRow).toBeDefined();
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 7: supersede CAS — tenant-scoped --------------------------------
  it('supersede across tenants throws "Memory not found" via readEntry tenant scope', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: { subject: 'cli', role: 'admin' } },
      { content: 'alpha-row supersede tenant-scope canary' },
    );

    expect(() =>
      supersede(
        { hippoRoot: home, tenantId: 'bravo', actor: { subject: 'api_key:bravo-key', role: 'admin' } },
        created.id,
        'cross-tenant supersede attempt',
      ),
    ).toThrow(/memory not found/i);

    // The original row is untouched: no superseded_by, no new memory created.
    const db = openHippoDb(home);
    try {
      const row = queryRow<{ tenant_id: string; superseded_by: string | null }>(
        db,
        `SELECT tenant_id, superseded_by FROM memories WHERE id = ?`,
        created.id,
      );
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
      expect(row!.superseded_by).toBeNull();

      const totalRows = queryRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM memories`)!;
      expect(Number(totalRows.c)).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: authCreate body tenantId ignored (HTTP layer regression)
// ---------------------------------------------------------------------------
//
// HTTP POST /v1/auth/keys with a Bearer for tenant alpha and a body
// containing tenantId='bravo' must mint the key for ALPHA, not bravo.
// The body field is ignored at the HTTP layer; opts.tenantId no longer
// exists on AuthCreateOpts.

describe('authCreate HTTP body.tenantId ignored', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot('v039-authcreate');
    globalHome = makeRoot('v039-authcreate-global');
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
    try { rmSync(globalHome, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('POST /v1/auth/keys ignores body.tenantId, binds key to bearer tenant', async () => {
    // Mint an alpha key directly so we have a Bearer for tenant alpha.
    const db = openHippoDb(home);
    let alphaPlaintext: string;
    try {
      const created = createApiKey(db, { tenantId: 'alpha', label: 'alpha-bootstrap' });
      alphaPlaintext = created.plaintext;
    } finally {
      closeHippoDb(db);
    }

    // Call POST /v1/auth/keys as alpha but try to smuggle tenantId='bravo'
    // in the body. The route handler must drop body.tenantId and bind the
    // new key to ctx.tenantId='alpha'.
    const res = await fetch(`${handle.url}/v1/auth/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${alphaPlaintext}`,
      },
      body: JSON.stringify({ tenantId: 'bravo', label: 'should-be-alpha' }),
    });
    expect(res.status).toBe(200);
    // SAFETY: POST /v1/auth/keys returns AuthCreateResult {keyId, plaintext,
    // tenantId, role} verbatim via sendJson (src/api.ts authCreate + the
    // /v1/auth/keys route in src/server.ts).
    const body = await res.json() as { keyId: string; plaintext: string; tenantId: string };
    expect(body.tenantId).toBe('alpha');
    expect(body.keyId).toMatch(/^hk_/);

    // Confirm in the DB: the api_keys row carries tenant_id='alpha'.
    const db2 = openHippoDb(home);
    try {
      const row = queryRow<{ tenant_id: string }>(db2, `SELECT tenant_id FROM api_keys WHERE key_id = ?`, body.keyId);
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db2);
    }
  });
});
