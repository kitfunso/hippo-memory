import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { archiveRawMemory } from '../src/raw-archive.js';

describe('archiveRawMemory', () => {
  it('snapshots row into raw_archive then removes it from memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-arch-'));
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('r1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','sensitive content','raw')`,
    ).run();
    archiveRawMemory(db, 'r1', { reason: 'GDPR right-to-be-forgotten', who: 'user:42' });
    const remaining = db.prepare(`SELECT id FROM memories WHERE id='r1'`).get();
    expect(remaining).toBeUndefined();
    const archived = db
      .prepare(`SELECT memory_id, reason, archived_by, payload_json FROM raw_archive WHERE memory_id='r1'`)
      .get() as { memory_id: string; reason: string; archived_by: string; payload_json: string };
    expect(archived.memory_id).toBe('r1');
    expect(archived.reason).toBe('GDPR right-to-be-forgotten');
    expect(archived.archived_by).toBe('user:42');
    const payload = JSON.parse(archived.payload_json) as Record<string, unknown>;
    expect(payload.id).toBe('r1');
    expect(payload.content).toBe('sensitive content');
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses to archive non-raw memories', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-arch-'));
    const db = openHippoDb(home);
    db.prepare(
      `INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength, half_life_days, layer, tags_json, emotional_valence, schema_fit, source, conflicts_with_json, pinned, confidence, content, kind) VALUES ('d1','2026-01-01','2026-01-01',0,1.0,7,'episodic','[]','neutral',0.5,'test','[]',0,'observed','c','distilled')`,
    ).run();
    expect(() => archiveRawMemory(db, 'd1', { reason: 'test', who: 'user:1' })).toThrow(/not raw/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });

  it('throws when memory id does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-arch-'));
    const db = openHippoDb(home);
    expect(() => archiveRawMemory(db, 'missing', { reason: 'test', who: 'user:1' })).toThrow(/not found/i);
    closeHippoDb(db);
    rmSync(home, { recursive: true, force: true });
  });
});
