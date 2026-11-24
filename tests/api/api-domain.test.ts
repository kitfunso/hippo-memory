import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BadRequestError, ConflictError } from '../../src/base/errors/api-errors.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import {
  remember,
  retrieve,
  forget,
  promote,
  supersede,
  rawArchive,
  authCreate,
  authListRows,
  authRevoke,
  auditList,
} from '../../src/api/index.js';
import { appendAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, readEntry, apiCtx } = sessionPerTest();

describe('api domain — recall/forget/promote/supersede', () => {
  let home: string;
  let globalHome: string;

  beforeEach(() => {
    home = makeRoot('api-dom');
    globalHome = makeRoot('api-glob');
    vi.stubEnv('HIPPO_HOME', globalHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('recall returns BM25 candidates and audits with the supplied actor', async () => {
    await remember(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      content: 'recall-canary alpha-token sentinel',
    });
    await remember(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      content: 'unrelated content for noise',
    });

    const result = await retrieve(apiCtx(home, 'default', { subject: 'api_key:hk_recall', role: 'admin' }), {
      query: 'alpha-token',
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.content).toContain('alpha-token');
    expect(result.results[0]!.id).toMatch(/^mem_/);
    expect(result.total).toBe(1);
    expect(result.tokens).toBe(9);

    const db = openHippoDb(home);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_recall');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget deletes the row and audits with the supplied actor', async () => {
    const { id } = await remember(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      content: 'forget-me-please',
    });
    expect(readEntry(home, id)?.id).toBe(id);

    const result = await forget(apiCtx(home, 'default', { subject: 'api_key:hk_forget', role: 'admin' }), id);
    expect(result).toEqual({ ok: true, id });
    expect(readEntry(home, id)).toBeNull();

    const db = openHippoDb(home);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'forget' });
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_forget');
      expect(events[0]!.targetId).toBe(id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('promote copies a memory into the global store and audits with the supplied actor', async () => {
    const { id } = await remember(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      content: 'promote-me-to-global',
    });

    const result = await promote(apiCtx(home, 'default', { subject: 'api_key:hk_promote', role: 'admin' }), id);
    expect(result.ok).toBe(true);
    expect(result.sourceId).toBe(id);
    expect(result.globalId).toMatch(/^g_/);

    // Global copy exists with new id.
    const globalEntry = readEntry(globalHome, result.globalId);
    expect(globalEntry?.content).toBe('promote-me-to-global');

    const db = openHippoDb(globalHome);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'promote' });
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_promote');
      expect(events[0]!.targetId).toBe(result.globalId);
      expect(events[0]!.metadata).toMatchObject({ sourceId: id });
    } finally {
      closeHippoDb(db);
    }
  });

  it('promote keeps the lead-in on the global copy', async () => {
    const lead = 'user: How often do you and Mel run?';
    const { id } = await remember(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      content: 'Three times a week; it keeps us on track.',
      leadIn: lead,
    });

    const result = await promote(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), id);

    expect(readEntry(globalHome, result.globalId)?.leadIn).toBe(lead);
  });

  it.each([
    [
      'quarantined',
      { scope: 'quarantine:private:unscoped' },
      'promote-veto quarantined row',
      (id: string) =>
        `Refusing to promote ${id}: it is quarantined pending review. Approve it first via 'hippo quarantine approve ${id}'.`,
    ],
    [
      'personal',
      { scope: 'personal:private:alice' },
      'promote-veto personal row',
      (id: string) => `Refusing to promote ${id}: it is a personal memory and stays with its owner on this server.`,
    ],
    [
      'secret',
      {},
      'service api key sk_vendor_deadbeef123456 for the ingest worker',
      (id: string) =>
        `Refusing to promote ${id} to the global store: content matches secret material ` +
        `(pattern:sk-underscore-key). Secrets stay in their owning project's store.`,
    ],
    [
      'secret-in-lead-in',
      { leadIn: 'service api key sk_vendor_deadbeef123456 for the ingest worker' },
      'promote-veto lead-in row',
      (id: string) =>
        `Refusing to promote ${id} to the global store: content matches secret material ` +
        `(pattern:sk-underscore-key). Secrets stay in their owning project's store.`,
    ],
  ] as const)(
    'promote refuses a %s row with a 400 and its text, writing no copy and no promote row',
    async (_kind, scope, content, text) => {
      const row = createMemory(content, { tenantId: 'default', ...scope });
      writeEntry(home, row);
      const ctx = apiCtx(home, 'default', { subject: 'api_key:hk_promote', role: 'admin', owner: 'alice' });

      const err = await promote(ctx, row.id).catch((e: Error) => e);

      expect(err).toBeInstanceOf(BadRequestError);
      expect(err).toMatchObject({ status: 400, message: text(row.id) });
      const db = openHippoDb(globalHome);
      try {
        expect(listAuditEvents(db, { tenantId: 'default', op: 'promote' })).toEqual([]);
        expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
      } finally {
        closeHippoDb(db);
      }
    },
  );

  it('promote refuses a superseded row with a 409 naming its successor, writing no copy and no promote row', async () => {
    const admin = apiCtx(home, 'default', { subject: 'api_key:hk_promote', role: 'admin' });
    const { id: oldId } = await remember(admin, { content: 'promote-superseded-original' });
    const { newId } = await supersede(admin, oldId, 'promote-superseded-successor');

    const err = await promote(admin, oldId).catch((e: Error) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toMatchObject({
      status: 409,
      message: `Refusing to promote ${oldId}: it is superseded by ${newId}; promote that one instead.`,
    });
    const db = openHippoDb(globalHome);
    try {
      expect(listAuditEvents(db, { tenantId: 'default', op: 'promote' })).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM memories').get()).toEqual({ n: 0 });
    } finally {
      closeHippoDb(db);
    }
  });

  it('supersede chains old -> new and audits with the supplied actor', async () => {
    const { id: oldId } = await remember(apiCtx(home, 'default', { subject: 'cli', role: 'admin' }), {
      content: 'original-belief',
    });

    const result = await supersede(
      apiCtx(home, 'default', { subject: 'api_key:hk_supersede', role: 'admin' }),
      oldId,
      'updated-belief',
    );
    expect(result.ok).toBe(true);
    expect(result.oldId).toBe(oldId);
    expect(result.newId).toMatch(/^mem_/);
    expect(result.newId).not.toBe(oldId);

    const oldEntry = readEntry(home, oldId);
    const newEntry = readEntry(home, result.newId);
    expect(oldEntry?.supersededBy).toBe(result.newId);
    expect(newEntry?.content).toBe('updated-belief');

    const db = openHippoDb(home);
    try {
      const events = listAuditEvents(db, { tenantId: 'default', op: 'supersede' });
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_supersede');
      expect(events[0]!.targetId).toBe(oldId);
      expect(events[0]!.metadata).toMatchObject({ newId: result.newId });
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('api domain — archive_raw / auth / audit', () => {
  let home: string;

  beforeEach(() => {
    home = makeRoot('api-aux');
  });

  it('rawArchive moves a kind=raw row into raw_archive and removes it from memories', async () => {
    const db = openHippoDb(home);
    let rawId: string;
    try {
      rawId = `mem_raw_${Math.random().toString(36).slice(2, 10)}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO memories(
           id, created, last_retrieved, retrieval_count, strength, half_life_days, layer,
           tags_json, emotional_valence, schema_fit, source, outcome_score,
           outcome_positive, outcome_negative,
           conflicts_with_json, pinned, confidence, content,
           parents_json, starred,
           valid_from, kind, tenant_id, updated_at
         ) VALUES (?, ?, ?, 0, 0.5, 30, 'episodic',
                   '[]', 0, 0, 'manual', 0,
                   0, 0,
                   '[]', 0, 'verified', 'raw-payload-canary',
                   '[]', 0,
                   ?, 'raw', 'default', datetime('now'))`,
      ).run(rawId, now, now, now);
    } finally {
      closeHippoDb(db);
    }

    const result = await rawArchive(
      apiCtx(home, 'default', { subject: 'api_key:hk_archive', role: 'admin' }),
      rawId,
      'gdpr-request',
    );
    expect(result.ok).toBe(true);
    expect(result.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const db2 = openHippoDb(home);
    try {
      const stillThere = db2.prepare(`SELECT id FROM memories WHERE id = ?`).get(rawId);
      expect(stillThere).toBeUndefined();

      // SAFETY: the db driver's .get() returns `unknown`; the row shape is guaranteed
      // by the `SELECT memory_id, reason, archived_by` projection above (undefined if absent).
      const archived = db2
        .prepare(`SELECT memory_id, reason, archived_by FROM raw_archive WHERE memory_id = ?`)
        .get(rawId) as { memory_id: string; reason: string; archived_by: string } | undefined;
      expect(archived?.memory_id).toBe(rawId);
      expect(archived?.reason).toBe('gdpr-request');
      expect(archived?.archived_by).toBe('api_key:hk_archive');

      const events = listAuditEvents(db2, { tenantId: 'default', op: 'archive_raw' });
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_archive');
      expect(events[0]!.targetId).toBe(rawId);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('authCreate + authList + authRevoke flow with cross-tenant guard', async () => {
    const ctxA: FullContext = apiCtx(home, 'tenant-a', { subject: 'cli', role: 'admin' });
    const ctxB: FullContext = apiCtx(home, 'tenant-b', { subject: 'cli', role: 'admin' });

    const k1 = await authCreate(ctxA, { label: 'first' });
    expect(k1.keyId).toMatch(/^hk_/);
    expect(k1.plaintext).toContain(`${k1.keyId}.`);
    expect(k1.tenantId).toBe('tenant-a');

    const k2 = await authCreate(ctxA, { label: 'second' });
    const kOther = await authCreate(ctxB, { label: 'other-tenant' });

    const activeA = await authListRows(ctxA, { active: true });
    const activeIds = activeA.map((r) => r.key.keyId).sort();
    expect(activeIds).toEqual([k1.keyId, k2.keyId].sort());

    const revoked = await authRevoke(ctxA, k2.keyId);
    expect(revoked.ok).toBe(true);
    expect(revoked.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const activeAfter = await authListRows(ctxA, { active: true });
    expect(activeAfter.map((r) => r.key.keyId)).toEqual([k1.keyId]);
    const allAfter = await authListRows(ctxA, { active: false });
    expect(allAfter.map((r) => r.key.keyId).sort()).toEqual([k1.keyId, k2.keyId].sort());

    await expect(authRevoke(ctxA, kOther.keyId)).rejects.toThrow(/Unknown key_id/);

    const activeB = await authListRows(ctxB, { active: true });
    expect(activeB.map((r) => r.key.keyId)).toEqual([kOther.keyId]);

    const db = openHippoDb(home);
    try {
      const aEvents = listAuditEvents(db, { tenantId: 'tenant-a', op: 'auth_revoke' });
      expect(aEvents.length).toBe(1);
      expect(aEvents[0]!.targetId).toBe(k2.keyId);

      const bEvents = listAuditEvents(db, { tenantId: 'tenant-b', op: 'auth_revoke' });
      expect(bEvents.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('auditList scopes to ctx.tenantId and filters by op', async () => {
    const db = openHippoDb(home);
    try {
      appendAuditEvents(db, [{ tenantId: 'tenant-a', actor: 'cli', op: 'remember', targetId: 'a1' }]);
      appendAuditEvents(db, [{ tenantId: 'tenant-a', actor: 'cli', op: 'forget', targetId: 'a2' }]);
      appendAuditEvents(db, [{ tenantId: 'tenant-b', actor: 'cli', op: 'remember', targetId: 'b1' }]);
    } finally {
      closeHippoDb(db);
    }

    const aAll = await auditList(apiCtx(home, 'tenant-a', { subject: 'cli', role: 'admin' }), {});
    expect(aAll.length).toBe(2);
    expect(aAll.every((e) => e.tenantId === 'tenant-a')).toBe(true);

    const aRemember = await auditList(apiCtx(home, 'tenant-a', { subject: 'cli', role: 'admin' }), { op: 'remember' });
    expect(aRemember.length).toBe(1);
    expect(aRemember[0]!.targetId).toBe('a1');

    const bAll = await auditList(apiCtx(home, 'tenant-b', { subject: 'cli', role: 'admin' }), {});
    expect(bAll.length).toBe(1);
    expect(bAll[0]!.targetId).toBe('b1');
  });
});
