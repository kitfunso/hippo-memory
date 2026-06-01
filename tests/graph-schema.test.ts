/**
 * E3.3 graph-on-consolidated guard - schema v37 shape.
 * Docs: docs/plans/2026-06-01-e3-graph-guard.md
 *
 * Pins the 3 tables + 7 indexes + 6 guard triggers (INSERT and UPDATE per table).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb, getCurrentSchemaVersion } from '../src/db.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-graph-schema-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('graph schema v37 (E3.3)', () => {
  let home: string;
  beforeEach(() => { home = makeRoot(); });
  afterEach(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('CURRENT_SCHEMA_VERSION is 37', () => {
    expect(getCurrentSchemaVersion()).toBe(37);
  });

  it('creates entities + relations + graph_extraction_queue tables', () => {
    const db = openHippoDb(home);
    try {
      for (const t of ['entities', 'relations', 'graph_extraction_queue']) {
        expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `missing table ${t}`).toBeDefined();
      }
    } finally { closeHippoDb(db); }
  });

  it('creates the 7 graph indexes', () => {
    const db = openHippoDb(home);
    try {
      const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND (name LIKE 'idx_entities_%' OR name LIKE 'idx_relations_%' OR name LIKE 'idx_graph_%')`)
        .all() as Array<{ name: string }>).map((r) => r.name);
      for (const idx of [
        'idx_entities_tenant', 'idx_entities_memory',
        'idx_relations_tenant', 'idx_relations_from', 'idx_relations_to', 'idx_relations_memory',
        'idx_graph_queue_status',
      ]) {
        expect(names, `missing index ${idx}`).toContain(idx);
      }
    } finally { closeHippoDb(db); }
  });

  it('creates the 6 graph-table guard triggers (INSERT + UPDATE per table)', () => {
    const db = openHippoDb(home);
    try {
      const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'trg_entities_%' OR name LIKE 'trg_relations_%' OR name LIKE 'trg_graph_queue_%')`)
        .all() as Array<{ name: string }>).map((r) => r.name);
      for (const trg of [
        'trg_entities_consolidated_only_insert', 'trg_entities_consolidated_only_update',
        'trg_relations_consolidated_only_insert', 'trg_relations_consolidated_only_update',
        'trg_graph_queue_consolidated_only_insert', 'trg_graph_queue_consolidated_only_update',
      ]) {
        expect(names, `missing trigger ${trg}`).toContain(trg);
      }
    } finally { closeHippoDb(db); }
  });

  it('creates the reverse-guard triggers (codex P1 + P2): memories + entities', () => {
    const db = openHippoDb(home);
    try {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_memories_graph_referenced_guard'`).get()).toBeDefined();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_entities_no_tenant_move_when_referenced'`).get()).toBeDefined();
    } finally { closeHippoDb(db); }
  });
});
