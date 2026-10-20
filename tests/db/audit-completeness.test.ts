import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { archiveRawMemory } from '../../src/store/sqlite/raw-archive.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runCliOut } from '../_helpers/run-cli-as.js';

/** Query a single row from the hippo SQLite handle. */
function queryOne<T>(db: DatabaseSyncLike, sql: string, ...params: unknown[]): T | undefined {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).get(...params) as T | undefined;
}

describe('audit log captures every mutation', () => {
  it('remember + recall both logged via CLI flow', async () => {
    // HIPPO_HOME is the global root in --global mode (see getGlobalRoot in
    // src/domain/sharing/global-store.ts). Same pattern as tests/store/recall-why-envelope.test.ts.
    const home = makeRoot('audit-cli', { init: false });
    const env = { ...process.env, HIPPO_HOME: home };
    await runCliOut(['init'], { env, cwd: home });
    await runCliOut(['init', '--global'], { env, cwd: home });
    await runCliOut(['remember', 'audit-canary-99 distinguishing token', '--global'], { env, cwd: home });
    await runCliOut(['recall', 'audit-canary-99'], { env, cwd: home });

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default' });
      const ops = events.map((e) => e.op);
      expect(ops).toContain('remember');
      expect(ops).toContain('recall');
    } finally {
      closeHippoDb(db);
    }
  });

  it('promote logs a promote event on the global store', async () => {
    const home = makeRoot('audit-promote', { init: false });
    const env = { ...process.env, HIPPO_HOME: home };
    await runCliOut(['init'], { env, cwd: home });
    await runCliOut(['init', '--global'], { env, cwd: home });
    await runCliOut(['remember', 'audit-promote-canary-55 distinguishing token'], { env, cwd: home });
    const localRoot = join(home, '.hippo');
    const dbLocal = openHippoDb(localRoot);
    let localId: string | undefined;
    try {
      const row = queryOne<{ id?: string }>(
        dbLocal,
        `SELECT id FROM memories WHERE content LIKE '%audit-promote-canary-55%' LIMIT 1`,
      );
      localId = row?.id;
    } finally {
      closeHippoDb(dbLocal);
    }
    expect(localId, 'expected to find local row id').toBeTruthy();

    await runCliOut(['promote', localId!], { env, cwd: home });

    // promote audit lands on the global store (HIPPO_HOME).
    const dbGlobal = openHippoDb(home);
    try {
      const events = queryAuditEvents(dbGlobal, { tenantId: 'default', op: 'promote' });
      expect(events).toHaveLength(1);
      const meta = events[0]!.metadata;
      expect(meta.sourceId).toBe(localId);
    } finally {
      closeHippoDb(dbGlobal);
    }
  });

  it('supersede logs a supersede event with newId metadata', async () => {
    const home = makeRoot('audit-supersede', { init: false });
    const env = { ...process.env, HIPPO_HOME: home };
    await runCliOut(['init'], { env, cwd: home });
    await runCliOut(['remember', 'audit-supersede-canary-33 old content'], { env, cwd: home });
    const localRoot = join(home, '.hippo');
    const db = openHippoDb(localRoot);
    let oldId: string | undefined;
    try {
      const row = queryOne<{ id?: string }>(
        db,
        `SELECT id FROM memories WHERE content LIKE '%audit-supersede-canary-33%' LIMIT 1`,
      );
      oldId = row?.id;
    } finally {
      closeHippoDb(db);
    }
    expect(oldId, 'expected to find old row id').toBeTruthy();

    await runCliOut(['supersede', oldId!, 'audit-supersede-canary-33 new content'], { env, cwd: home });

    const db2 = openHippoDb(localRoot);
    try {
      const events = queryAuditEvents(db2, { tenantId: 'default', op: 'supersede' });
      const match = events.find((e) => e.targetId === oldId);
      expect(match, `expected supersede event for ${oldId}`).toBeTruthy();
      const meta = match!.metadata;
      expect(meta.newId).toBeTruthy();
      expect(meta.newId).not.toBe(oldId);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('archiveRawMemory logs an archive_raw event with row tenant_id', () => {
    const home = makeRoot('audit-archive');
    const db = openHippoDb(home);
    try {
      // Insert a raw row directly with a non-default tenant to confirm M3:
      // archive_raw audit must use the row's tenant_id, not env.
      db.prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind, tenant_id) VALUES ('raw1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','sensitive','raw','tenant_x')`,
      ).run();

      archiveRawMemory(db, 'raw1', { reason: 'GDPR', who: 'user:42' });

      const events = queryAuditEvents(db, { tenantId: 'tenant_x', op: 'archive_raw' });
      expect(events.length).toBe(1);
      expect(events[0]!.targetId).toBe('raw1');
      expect(events[0]!.actor).toBe('user:42');
      const meta = events[0]!.metadata;
      expect(meta.reason).toBe('GDPR');

      // And nothing leaks into the default tenant.
      const defaultEvents = queryAuditEvents(db, { tenantId: 'default', op: 'archive_raw' });
      expect(defaultEvents.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget logs a forget event', async () => {
    const home = makeRoot('audit-forget', { init: false });
    const env = { ...process.env, HIPPO_HOME: home };
    // Local store flow (forgetMemory is local-store only). Remember + forget
    // both target the local .hippo dir under cwd=home.
    await runCliOut(['init'], { env, cwd: home });
    await runCliOut(['remember', 'audit-forget-canary-77 distinguishing token'], { env, cwd: home });
    const localRoot = join(home, '.hippo');
    const db = openHippoDb(localRoot);
    let rememberedId: string | undefined;
    try {
      const row = queryOne<{ id?: string }>(
        db,
        `SELECT id FROM memories WHERE content LIKE '%audit-forget-canary-77%' LIMIT 1`,
      );
      rememberedId = row?.id;
    } finally {
      closeHippoDb(db);
    }
    expect(rememberedId, 'expected to find row id in local db').toBeTruthy();

    await runCliOut(['forget', rememberedId!], { env, cwd: home });

    const db2 = openHippoDb(localRoot);
    try {
      const events = queryAuditEvents(db2, { tenantId: 'default', op: 'forget' });
      const ids = events.map((e) => e.targetId);
      expect(ids).toContain(rememberedId);
    } finally {
      closeHippoDb(db2);
    }
  });
});
