import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion } from '../src/db.js';

describe('A5 schema migration v16: tenant_id columns', () => {
  it('migrates to schema version 16', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a5-'));
    const db = openHippoDb(home);
    try {
      expect(getSchemaVersion(db)).toBe(16);
      expect(getCurrentSchemaVersion()).toBe(16);
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
