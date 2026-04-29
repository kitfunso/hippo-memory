import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, readEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import {
  remember,
  recall,
  forget,
  promote,
  supersede,
  archiveRaw,
  authCreate,
  authList,
  authRevoke,
  auditList,
} from '../src/api.js';
import { appendAuditEvent } from '../src/audit.js';

describe('api domain — recall/forget/promote/supersede', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-api-dom-'));
    globalHome = mkdtempSync(join(tmpdir(), 'hippo-api-glob-'));
    initStore(home);
    initStore(globalHome);
    // Pin the global store to our tmpdir for promote().
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
  });

  afterEach(() => {
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('recall returns BM25 candidates and audits with the supplied actor', () => {
    remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'recall-canary alpha-token sentinel' },
    );
    remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'unrelated content for noise' },
    );

    const result = recall(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_recall' },
      { query: 'alpha-token' },
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.content).toContain('alpha-token');
    expect(result.results[0]!.id).toMatch(/^mem_/);
    expect(result.total).toBeGreaterThan(0);
    expect(result.tokens).toBeGreaterThan(0);

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'recall' });
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_recall');
    } finally {
      closeHippoDb(db);
    }
  });

  it('forget deletes the row and audits with the supplied actor', () => {
    const { id } = remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'forget-me-please' },
    );
    expect(readEntry(home, id)?.id).toBe(id);

    const result = forget(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_forget' },
      id,
    );
    expect(result).toEqual({ ok: true, id });
    expect(readEntry(home, id)).toBeNull();

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'forget' });
      // Task 4 dedupe: deleteEntry threads ctx.actor; exactly one event lands.
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_forget');
      expect(events[0]!.targetId).toBe(id);
    } finally {
      closeHippoDb(db);
    }
  });

  it('promote copies a memory into the global store and audits with the supplied actor', () => {
    const { id } = remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'promote-me-to-global' },
    );

    const result = promote(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_promote' },
      id,
    );
    expect(result.ok).toBe(true);
    expect(result.sourceId).toBe(id);
    expect(result.globalId).toMatch(/^g_/);

    // Global copy exists with new id.
    const globalEntry = readEntry(globalHome, result.globalId);
    expect(globalEntry?.content).toBe('promote-me-to-global');

    const db = openHippoDb(globalHome);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'promote' });
      // Task 4 dedupe: exactly one 'promote' event on the global store.
      expect(events.length).toBe(1);
      expect(events[0]!.actor).toBe('api_key:hk_promote');
      expect(events[0]!.targetId).toBe(result.globalId);
      expect(events[0]!.metadata).toMatchObject({ sourceId: id });
    } finally {
      closeHippoDb(db);
    }
  });

  it('supersede chains old -> new and audits with the supplied actor', () => {
    const { id: oldId } = remember(
      { hippoRoot: home, tenantId: 'default', actor: 'cli' },
      { content: 'original-belief' },
    );

    const result = supersede(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_supersede' },
      oldId,
      'updated-belief',
    );
    expect(result.ok).toBe(true);
    expect(result.oldId).toBe(oldId);
    expect(result.newId).toMatch(/^mem_/);
    expect(result.newId).not.toBe(oldId);

    const oldEntry = readEntry(home, oldId);
    const newEntry = readEntry(home, result.newId);
    expect(oldEntry?.superseded_by).toBe(result.newId);
    expect(newEntry?.content).toBe('updated-belief');

    const db = openHippoDb(home);
    try {
      const events = queryAuditEvents(db, { tenantId: 'default', op: 'supersede' });
      // Task 4 dedupe: exactly one 'supersede' event with the supplied actor.
      // (The two 'remember' events from the underlying writeEntry calls land
      // under op='remember' and are not counted here.)
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
    home = mkdtempSync(join(tmpdir(), 'hippo-api-aux-'));
    initStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('archiveRaw moves a kind=raw row into raw_archive and removes it from memories', () => {
    // createMemory defaults to distilled, but archiveRawMemory only accepts
    // kind='raw'. Insert a raw row directly via SQL to seed the test.
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

    const result = archiveRaw(
      { hippoRoot: home, tenantId: 'default', actor: 'api_key:hk_archive' },
      rawId,
      'gdpr-request',
    );
    expect(result.ok).toBe(true);
    expect(result.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Row should be gone from memories, snapshot present in raw_archive,
    // and an archive_raw audit event with the supplied actor.
    const db2 = openHippoDb(home);
    try {
      const stillThere = db2.prepare(`SELECT id FROM memories WHERE id = ?`).get(rawId);
      expect(stillThere).toBeUndefined();

      const archived = db2
        .prepare(`SELECT memory_id, reason, archived_by FROM raw_archive WHERE memory_id = ?`)
        .get(rawId) as { memory_id: string; reason: string; archived_by: string } | undefined;
      expect(archived?.memory_id).toBe(rawId);
      expect(archived?.reason).toBe('gdpr-request');
      expect(archived?.archived_by).toBe('api_key:hk_archive');

      const events = queryAuditEvents(db2, { tenantId: 'default', op: 'archive_raw' });
      expect(events.length).toBe(1); // not double-emitted
      expect(events[0]!.actor).toBe('api_key:hk_archive');
      expect(events[0]!.targetId).toBe(rawId);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('authCreate + authList + authRevoke flow with cross-tenant guard', () => {
    const ctxA = { hippoRoot: home, tenantId: 'tenant-a', actor: 'cli' };
    const ctxB = { hippoRoot: home, tenantId: 'tenant-b', actor: 'cli' };

    const k1 = authCreate(ctxA, { label: 'first' });
    expect(k1.keyId).toMatch(/^hk_/);
    expect(k1.plaintext).toContain(`${k1.keyId}.`);
    expect(k1.tenantId).toBe('tenant-a');

    const k2 = authCreate(ctxA, { label: 'second' });
    const kOther = authCreate(ctxB, { label: 'other-tenant' });

    // List active for tenant-a sees k1 + k2 only (not kOther).
    const activeA = authList(ctxA, { active: true });
    const activeIds = activeA.map((k) => k.keyId).sort();
    expect(activeIds).toEqual([k1.keyId, k2.keyId].sort());

    // Revoke k2 as tenant-a.
    const revoked = authRevoke(ctxA, k2.keyId);
    expect(revoked.ok).toBe(true);
    expect(revoked.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // After revoke: active = [k1], all = [k1, k2].
    const activeAfter = authList(ctxA, { active: true });
    expect(activeAfter.map((k) => k.keyId)).toEqual([k1.keyId]);
    const allAfter = authList(ctxA, { active: false });
    expect(allAfter.map((k) => k.keyId).sort()).toEqual([k1.keyId, k2.keyId].sort());

    // Cross-tenant revoke must be rejected with the same "not found" message
    // as a missing key, so caller cannot probe other tenants' key_ids.
    expect(() => authRevoke(ctxA, kOther.keyId)).toThrow(/Unknown key_id/);

    // kOther must still be active on tenant-b.
    const activeB = authList(ctxB, { active: true });
    expect(activeB.map((k) => k.keyId)).toEqual([kOther.keyId]);

    // Audit: the auth_revoke event uses the KEY's tenant, not ctx.tenantId.
    // Here ctx.tenantId === key.tenant_id (both tenant-a) so the check is
    // implicit; the cross-tenant case throws before audit and so leaves no
    // audit trail.
    const db = openHippoDb(home);
    try {
      const aEvents = queryAuditEvents(db, { tenantId: 'tenant-a', op: 'auth_revoke' });
      expect(aEvents.length).toBe(1);
      expect(aEvents[0]!.targetId).toBe(k2.keyId);

      const bEvents = queryAuditEvents(db, { tenantId: 'tenant-b', op: 'auth_revoke' });
      expect(bEvents.length).toBe(0);
    } finally {
      closeHippoDb(db);
    }
  });

  it('auditList scopes to ctx.tenantId and filters by op', () => {
    // Seed events directly so the test is independent of remember/recall.
    const db = openHippoDb(home);
    try {
      appendAuditEvent(db, { tenantId: 'tenant-a', actor: 'cli', op: 'remember', targetId: 'a1' });
      appendAuditEvent(db, { tenantId: 'tenant-a', actor: 'cli', op: 'forget', targetId: 'a2' });
      appendAuditEvent(db, { tenantId: 'tenant-b', actor: 'cli', op: 'remember', targetId: 'b1' });
    } finally {
      closeHippoDb(db);
    }

    const aAll = auditList(
      { hippoRoot: home, tenantId: 'tenant-a', actor: 'cli' },
      {},
    );
    expect(aAll.length).toBe(2);
    expect(aAll.every((e) => e.tenantId === 'tenant-a')).toBe(true);

    const aRemember = auditList(
      { hippoRoot: home, tenantId: 'tenant-a', actor: 'cli' },
      { op: 'remember' },
    );
    expect(aRemember.length).toBe(1);
    expect(aRemember[0]!.targetId).toBe('a1');

    const bAll = auditList(
      { hippoRoot: home, tenantId: 'tenant-b', actor: 'cli' },
      {},
    );
    expect(bAll.length).toBe(1);
    expect(bAll[0]!.targetId).toBe('b1');
  });
});
