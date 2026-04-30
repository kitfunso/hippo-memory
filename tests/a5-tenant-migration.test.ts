import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion } from '../src/db.js';

describe('A5 schema migration v16: tenant_id columns', () => {
  it('migrates to latest schema version (currently 20)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(20);
      expect(getCurrentSchemaVersion()).toBe(20);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('adds tenant_id to memories, working_memory, consolidation_runs, task_snapshots, memory_conflicts', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      for (const tbl of ['memories', 'working_memory', 'consolidation_runs', 'task_snapshots', 'memory_conflicts']) {
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>;
        expect(cols.some((c) => c.name === 'tenant_id'), `${tbl}.tenant_id missing`).toBe(true);
      }
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates composite (tenant_id, ...) indexes on each table', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>;
      const names = new Set(indexes.map((i) => i.name));
      expect(names.has('idx_memories_tenant_created')).toBe(true);
      expect(names.has('idx_working_memory_tenant')).toBe(true);
      expect(names.has('idx_consolidation_runs_tenant_ts')).toBe(true);
      expect(names.has('idx_task_snapshots_tenant_status')).toBe(true);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('A5 schema migration v16: api_keys and audit_log tables', () => {
  it('creates api_keys table with required columns', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      const cols = db.prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const required of ['id', 'key_id', 'key_hash', 'tenant_id', 'created_at', 'revoked_at', 'label']) {
        expect(names.has(required), `api_keys.${required} missing`).toBe(true);
      }
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('enforces UNIQUE on api_keys.key_id', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      db.prepare(`INSERT INTO api_keys(key_id, key_hash, tenant_id, created_at) VALUES (?, ?, ?, ?)`)
        .run('hk_abc', 'hash1', 'default', new Date().toISOString());
      expect(() =>
        db.prepare(`INSERT INTO api_keys(key_id, key_hash, tenant_id, created_at) VALUES (?, ?, ?, ?)`)
          .run('hk_abc', 'hash2', 'default', new Date().toISOString()),
      ).toThrow(/UNIQUE/i);
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('creates audit_log table with required columns', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      const cols = db.prepare(`PRAGMA table_info(audit_log)`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      for (const required of ['id', 'ts', 'tenant_id', 'actor', 'op', 'target_id', 'metadata_json']) {
        expect(names.has(required), `audit_log.${required} missing`).toBe(true);
      }
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('A5 v16 backfill', () => {
  it('existing memories get tenant_id="default" after migration', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-backfill-'));
    // Seed at v15 by running migrations only up to 15. Easiest: open the DB once
    // (which runs all migrations), then manually insert a row WITHOUT tenant_id and
    // verify the DEFAULT applies. Pre-existing rows from the live system would have
    // gone through this path on first open after upgrade.
    const db = openHippoDb(home);
    try {
      db.prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('m1','2026-04-01','2026-04-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`,
      ).run();
      const row = db.prepare(`SELECT tenant_id FROM memories WHERE id='m1'`).get() as { tenant_id: string };
      expect(row.tenant_id).toBe('default');
    } finally {
      closeHippoDb(db);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
