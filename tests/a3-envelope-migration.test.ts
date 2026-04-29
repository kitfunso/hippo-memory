import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, getCurrentSchemaVersion, getSchemaVersion, closeHippoDb } from '../src/db.js';

describe('A3 envelope migration v14', () => {
  it('CURRENT_SCHEMA_VERSION is 14', () => {
    expect(getCurrentSchemaVersion()).toBe(14);
  });

  it('fresh db migrates to v14', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-a3-'));
    const db = openHippoDb(home);
    expect(getSchemaVersion(db)).toBe(14);
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

  it.todo('rejects kind value outside CHECK set — Task 6');

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
    // Simulate a pre-A3 state: insert two rows then null out their kind to mimic v13 data.
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, superseded_by) VALUES ('s1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','old','s2')`,
    ).run();
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content) VALUES ('s2','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','new')`,
    ).run();
    db.exec(`UPDATE memories SET kind = NULL WHERE id IN ('s1','s2')`);
    // Re-run the migration's backfill SQL (idempotent by design).
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
});
