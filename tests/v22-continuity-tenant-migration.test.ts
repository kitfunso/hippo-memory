import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';

describe('schema migration v22: tenant_id + scope on continuity tables', () => {
  it('adds tenant_id NOT NULL DEFAULT default and scope (nullable) to session_events', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v22-'));
    const db = openHippoDb(home);
    try {
      const cols = db.prepare(`PRAGMA table_info(session_events)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      const tenant = cols.find((c) => c.name === 'tenant_id');
      const scope = cols.find((c) => c.name === 'scope');
      expect(tenant).toBeDefined();
      expect(tenant!.notnull).toBe(1);
      expect(tenant!.dflt_value).toContain('default');
      expect(scope).toBeDefined();
      expect(scope!.notnull).toBe(0);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('adds tenant_id and scope to session_handoffs', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v22-'));
    const db = openHippoDb(home);
    try {
      const cols = db.prepare(`PRAGMA table_info(session_handoffs)`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
      expect(cols.some((c) => c.name === 'tenant_id' && c.notnull === 1)).toBe(true);
      expect(cols.some((c) => c.name === 'scope')).toBe(true);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates the (tenant_id, session_id) composite indexes', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v22-'));
    const db = openHippoDb(home);
    try {
      const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const names = new Set(idx.map((i) => i.name));
      expect(names.has('idx_session_events_tenant_session')).toBe(true);
      expect(names.has('idx_session_handoffs_tenant_session')).toBe(true);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('backfills tenant_id from task_snapshots.session_id when unambiguous', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v22-backfill-'));
    const db = openHippoDb(home);
    try {
      const now = new Date().toISOString();
      // Seed a task_snapshot under tenantA tied to sess-mapped
      db.prepare(`
        INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, tenant_id, created_at, updated_at)
        VALUES (?, ?, ?, 'active', 'test', 'sess-mapped', 'tenantA', ?, ?)
      `).run('t', 's', 'n', now, now);
      // Insert pre-existing rows directly with default tenant (simulates pre-v22 state)
      db.prepare(`UPDATE session_events SET tenant_id='default'`).run();
      db.prepare(`
        INSERT INTO session_events(session_id, event_type, content, source, metadata_json, tenant_id, created_at)
        VALUES ('sess-mapped', 'note', 'evt', 'test', '{}', 'default', ?)
      `).run(now);
      db.prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, tenant_id, created_at)
        VALUES ('sess-mapped', 'h', '[]', 'default', ?)
      `).run(now);
      // Run the backfill SQL the migration uses (idempotent)
      db.exec(`
        UPDATE session_events
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_events.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_events.session_id) = 1
      `);
      db.exec(`
        UPDATE session_handoffs
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_handoffs.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_handoffs.session_id) = 1
      `);

      const evt = db.prepare(`SELECT tenant_id FROM session_events WHERE session_id='sess-mapped'`).get() as { tenant_id: string };
      const hf = db.prepare(`SELECT tenant_id FROM session_handoffs WHERE session_id='sess-mapped'`).get() as { tenant_id: string };
      expect(evt.tenant_id).toBe('tenantA');
      expect(hf.tenant_id).toBe('tenantA');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves rows at default when session_id is ambiguous across tenants', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-v22-ambiguous-'));
    const db = openHippoDb(home);
    try {
      const now = new Date().toISOString();
      // Same session_id under two tenants -> ambiguous
      db.prepare(`
        INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, tenant_id, created_at, updated_at)
        VALUES ('a','a','a','active','test','sess-shared','tenantA',?,?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, tenant_id, created_at, updated_at)
        VALUES ('b','b','b','active','test','sess-shared','tenantB',?,?)
      `).run(now, now);
      db.prepare(`
        INSERT INTO session_events(session_id, event_type, content, source, metadata_json, tenant_id, created_at)
        VALUES ('sess-shared', 'note', 'e', 'test', '{}', 'default', ?)
      `).run(now);

      db.exec(`
        UPDATE session_events
           SET tenant_id = (
             SELECT MAX(t.tenant_id) FROM task_snapshots t
              WHERE t.session_id = session_events.session_id
           )
         WHERE tenant_id = 'default'
           AND (SELECT COUNT(DISTINCT t.tenant_id) FROM task_snapshots t
                 WHERE t.session_id = session_events.session_id) = 1
      `);

      const evt = db.prepare(`SELECT tenant_id FROM session_events WHERE session_id='sess-shared'`).get() as { tenant_id: string };
      expect(evt.tenant_id).toBe('default');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
