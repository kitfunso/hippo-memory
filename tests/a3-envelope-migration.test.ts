import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, getCurrentSchemaVersion, getSchemaVersion, closeHippoDb } from '../src/db.js';
import { createMemory, Layer } from '../src/memory.js';
import { writeEntry, readEntry, initStore } from '../src/store.js';

describe('A3 envelope migration v14+v15', () => {
  it('CURRENT_SCHEMA_VERSION is 21 (v14 + v15 hardening + v16 tenant_id + v17 slack tables + v18 B3 dlPFC depth + v19 slack_dlq columns + v20 GDPR Path A redact backfill + v21 raw_archive.mirror_cleaned_at)', () => {
    expect(getCurrentSchemaVersion()).toBe(25);
  });

  it('fresh db migrates to v21', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    expect(getSchemaVersion(db)).toBe(25);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('memories table has kind column with default distilled', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string; dflt_value: string | null }>;
    const kind = cols.find((c) => c.name === 'kind');
    expect(kind).toBeDefined();
    expect(kind!.dflt_value).toContain('distilled');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects kind value outside the allowed set', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('b1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','bogus')`,
      ).run(),
    ).toThrow(/invalid kind/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects UPDATE that sets kind to a value outside the allowed set', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('u1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`,
    ).run();
    expect(() => db.prepare(`UPDATE memories SET kind='bogus' WHERE id='u1'`).run()).toThrow(/invalid kind/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('CRITICAL REGRESSION: DELETE on kind=raw aborts via trigger', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('r1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','raw')`,
    ).run();
    expect(() => db.prepare(`DELETE FROM memories WHERE id='r1'`).run()).toThrow(/raw is append-only/);
    const row = db.prepare(`SELECT id FROM memories WHERE id='r1'`).get();
    expect(row).toBeDefined();
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('DELETE on kind=distilled proceeds normally', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('d1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`,
    ).run();
    db.prepare(`DELETE FROM memories WHERE id='d1'`).run();
    const row = db.prepare(`SELECT id FROM memories WHERE id='d1'`).get();
    expect(row).toBeUndefined();
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it.each(['scope', 'owner', 'artifact_ref'])('memories table has nullable %s column', (col) => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    const cols = db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string; notnull: number }>;
    const c = cols.find((x) => x.name === col);
    expect(c).toBeDefined();
    expect(c!.notnull).toBe(0);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('backfills kind=superseded for rows with superseded_by set, kind=distilled otherwise', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    // The v14→v15 NULL guard means we cannot null out kind in app code to simulate
    // pre-A3 state (the trigger aborts). Instead, drop the triggers, simulate, re-run
    // the migration's backfill clause, then verify. This tests the SQL clause itself.
    db.exec(`DROP TRIGGER IF EXISTS trg_memories_kind_check_insert`);
    db.exec(`DROP TRIGGER IF EXISTS trg_memories_kind_check_update`);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, superseded_by, kind) VALUES ('s1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','old','s2',NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('s2','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','new',NULL)`,
    ).run();
    // Re-run the v14 backfill SQL (idempotent by design)
    db.exec(`UPDATE memories SET kind = 'superseded' WHERE kind IS NULL AND superseded_by IS NOT NULL`);
    db.exec(`UPDATE memories SET kind = 'distilled' WHERE kind IS NULL`);
    const s1 = db.prepare(`SELECT kind FROM memories WHERE id='s1'`).get() as { kind: string };
    const s2 = db.prepare(`SELECT kind FROM memories WHERE id='s2'`).get() as { kind: string };
    expect(s1.kind).toBe('superseded');
    expect(s2.kind).toBe('distilled');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('raw_archive table exists with required columns', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    const cols = db.prepare(`PRAGMA table_info(raw_archive)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['id', 'memory_id', 'archived_at', 'reason', 'archived_by', 'payload_json']));
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('createMemory accepts envelope fields and round-trips through SQLite', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-mem-'));
    initStore(home);
    const e = createMemory('slack message ingested', {
      layer: Layer.Episodic,
      kind: 'raw',
      scope: 'team:eng',
      owner: 'user:42',
      artifact_ref: 'slack://team/channel/1700000000.123',
    });
    expect(e.kind).toBe('raw');
    expect(e.scope).toBe('team:eng');
    expect(e.owner).toBe('user:42');
    expect(e.artifact_ref).toBe('slack://team/channel/1700000000.123');

    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read).not.toBeNull();
    expect(read!.kind).toBe('raw');
    expect(read!.scope).toBe('team:eng');
    expect(read!.owner).toBe('user:42');
    expect(read!.artifact_ref).toBe('slack://team/channel/1700000000.123');
    rmSync(home, { recursive: true, force: true });
  });

  it('createMemory defaults envelope fields when not provided', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-mem-'));
    initStore(home);
    const e = createMemory('some distilled fact', { layer: Layer.Episodic });
    expect(e.kind).toBe('distilled');
    expect(e.scope).toBeNull();
    expect(e.owner).toBeNull();
    expect(e.artifact_ref).toBeNull();

    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read!.kind).toBe('distilled');
    expect(read!.scope).toBeNull();
    expect(read!.owner).toBeNull();
    expect(read!.artifact_ref).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  // v15 hardening: NULL-kind bypass closure + raw_archive uniqueness
  it('v15: rejects INSERT with kind=NULL (closes the v14 NULL bypass)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('null1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c',NULL)`,
      ).run(),
    ).toThrow(/invalid kind/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('v15: rejects UPDATE that sets kind=NULL', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('upd1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`,
    ).run();
    expect(() => db.prepare(`UPDATE memories SET kind=NULL WHERE id='upd1'`).run()).toThrow(/invalid kind/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('v15: raw_archive (memory_id, archived_at) is unique', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    const ts = '2026-04-29T12:00:00.000Z';
    db.prepare(
      `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
    ).run('m1', ts, 'test', 'user:1', '{}');
    expect(() =>
      db.prepare(
        `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
      ).run('m1', ts, 'duplicate at same instant', 'user:1', '{}'),
    ).toThrow(/UNIQUE constraint/i);
    // Different timestamps for the same memory_id are allowed (history)
    db.prepare(
      `INSERT INTO raw_archive (memory_id, archived_at, reason, archived_by, payload_json) VALUES (?, ?, ?, ?, ?)`,
    ).run('m1', '2026-04-29T13:00:00.000Z', 'second event', 'user:1', '{}');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
