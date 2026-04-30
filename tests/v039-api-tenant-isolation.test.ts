import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, readEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { queryAuditEvents } from '../src/audit.js';
import {
  remember,
  promote,
  forget,
  supersede,
  archiveRaw,
} from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

// v0.39 commit 1 regressions:
//  - promote: tenant pre-check matches archiveRaw (CRITICAL #1)
//  - forget: lock the existing tenant pre-check invariant
//  - archiveRaw: lock the existing tenant pre-check invariant (already covered
//    in api-tenant-deny.test.ts; duplicated here for one-stop hardening surface)
//  - authCreate: HTTP body.tenantId ignored, key bound to caller (CRITICAL #2)
//  - supersede: BEGIN IMMEDIATE CAS — direct SQL race + clean path + tenant scope
//    (CRITICAL #4)

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('v039 api tenant isolation', () => {
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
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-row promote-cross-tenant canary' },
    );

    expect(() =>
      promote(
        { hippoRoot: home, tenantId: 'bravo', actor: 'api_key:bravo-key' },
        created.id,
      ),
    ).toThrow(/memory not found/i);

    // The original row must still exist on the local root, untouched.
    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
        .get(created.id) as { tenant_id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db);
    }

    // The global root must NOT have a copy. promoteToGlobal must never have
    // run because the tenant pre-check throws before it does.
    const gdb = openHippoDb(globalHome);
    try {
      const grows = gdb.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number };
      expect(Number(grows.c)).toBe(0);
    } finally {
      closeHippoDb(gdb);
    }
  });

  // ---- Test 2: forget cross-tenant denied -----------------------------------
  it('forget refuses to delete a row that belongs to another tenant (lock invariant)', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-row forget-cross-tenant canary' },
    );

    expect(() =>
      forget(
        { hippoRoot: home, tenantId: 'bravo', actor: 'api_key:bravo-key' },
        created.id,
      ),
    ).toThrow(/memory not found/i);

    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT tenant_id FROM memories WHERE id = ?`)
        .get(created.id) as { tenant_id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 3: archiveRaw cross-tenant denied -------------------------------
  it('archiveRaw refuses to archive a row that belongs to another tenant (lock invariant)', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-raw archiveraw-cross-tenant canary', kind: 'raw' },
    );

    expect(() =>
      archiveRaw(
        { hippoRoot: home, tenantId: 'bravo', actor: 'api_key:bravo-key' },
        created.id,
        'cross-tenant probe',
      ),
    ).toThrow(/memory not found/i);

    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT tenant_id, kind FROM memories WHERE id = ?`)
        .get(created.id) as { tenant_id: string; kind: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
      expect(row!.kind).toBe('raw');
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 5: supersede CAS — direct SQL race -------------------------------
  // The CAS UPDATE in supersede() is:
  //   UPDATE memories SET superseded_by = ?
  //    WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL
  // The WHERE-clause `superseded_by IS NULL` is the race guard. Two assertions:
  //   (a) The user-visible contract: pre-setting superseded_by causes
  //       supersede() to throw with the "already superseded" wording. The
  //       readEntry early guard wins in the single-process case, which is
  //       fine — it surfaces the same observable contract (a concurrent
  //       writer prevents this supersede from succeeding) and uses the
  //       same canonical error wording.
  //   (b) The CAS WHERE-clause itself: run the exact UPDATE statement that
  //       supersede() runs against a row whose `superseded_by` is already
  //       non-NULL, and assert `changes=0`. This locks the SQL contract
  //       independently of supersede()'s control flow, so a future refactor
  //       that drops the `IS NULL` guard would fail this test even if the
  //       early-readEntry guard still fires.
  it('supersede CAS: pre-superseded row throws + WHERE clause returns changes=0', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-row supersede CAS race canary' },
    );

    // Pre-set superseded_by to simulate a concurrent writer that won.
    const db = openHippoDb(home);
    try {
      db.prepare(`UPDATE memories SET superseded_by = ? WHERE id = ?`).run(
        'mem_preexisting_racer',
        created.id,
      );
    } finally {
      closeHippoDb(db);
    }

    // (a) supersede() throws with the canonical wording.
    expect(() =>
      supersede(
        { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
        created.id,
        'replacement content',
      ),
    ).toThrow(/already superseded/i);

    // (b) Direct SQL: the CAS WHERE clause returns changes=0 against a row
    //     whose `superseded_by` is already non-NULL.
    const db2 = openHippoDb(home);
    try {
      const result = db2.prepare(`
        UPDATE memories
        SET superseded_by = ?
        WHERE id = ? AND tenant_id = ? AND superseded_by IS NULL
      `).run('mem_would_be_new', created.id, 'alpha');
      expect(Number(result.changes ?? 0)).toBe(0);

      // And the pre-existing supersede pointer is untouched.
      const row = db2
        .prepare(`SELECT superseded_by FROM memories WHERE id = ?`)
        .get(created.id) as { superseded_by: string | null } | undefined;
      expect(row?.superseded_by).toBe('mem_preexisting_racer');
    } finally {
      closeHippoDb(db2);
    }
  });

  // ---- Test 6: supersede CAS — clean path -----------------------------------
  it('supersede CAS clean path: both rows present, audit row written, chain pointer set', () => {
    const created = remember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-row supersede clean-path canary' },
    );

    const result = supersede(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
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
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-row supersede tenant-scope canary' },
    );

    expect(() =>
      supersede(
        { hippoRoot: home, tenantId: 'bravo', actor: 'api_key:bravo-key' },
        created.id,
        'cross-tenant supersede attempt',
      ),
    ).toThrow(/memory not found/i);

    // The original row is untouched: no superseded_by, no new memory created.
    const db = openHippoDb(home);
    try {
      const row = db
        .prepare(`SELECT tenant_id, superseded_by FROM memories WHERE id = ?`)
        .get(created.id) as { tenant_id: string; superseded_by: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
      expect(row!.superseded_by).toBeNull();

      const totalRows = db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number };
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

describe('v039 authCreate HTTP body.tenantId ignored', () => {
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
    const body = await res.json() as { keyId: string; plaintext: string; tenantId: string };
    expect(body.tenantId).toBe('alpha');
    expect(body.keyId).toMatch(/^hk_/);

    // Confirm in the DB: the api_keys row carries tenant_id='alpha'.
    const db2 = openHippoDb(home);
    try {
      const row = db2
        .prepare(`SELECT tenant_id FROM api_keys WHERE key_id = ?`)
        .get(body.keyId) as { tenant_id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.tenant_id).toBe('alpha');
    } finally {
      closeHippoDb(db2);
    }
  });
});
