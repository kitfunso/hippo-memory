import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
  };
};

let tmpDir: string;

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-sch-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('schema v3: trace columns', () => {
  it('round-trips trace_outcome + source_session_id on a fresh store', () => {
    initStore(tmpDir);
    const t = createMemory('traced experience content', {
      layer: Layer.Trace,
      trace_outcome: 'success',
      source_session_id: 'sess-1',
    });
    writeEntry(tmpDir, t);
    const loaded = loadAllEntries(tmpDir).find((e) => e.id === t.id);
    expect(loaded).toBeDefined();
    expect(loaded!.trace_outcome).toBe('success');
    expect(loaded!.source_session_id).toBe('sess-1');
    expect(loaded!.layer).toBe(Layer.Trace);
  });

  it('non-trace memories round-trip with trace fields null', () => {
    initStore(tmpDir);
    const m = createMemory('plain episodic memory content', { layer: Layer.Episodic });
    writeEntry(tmpDir, m);
    const loaded = loadAllEntries(tmpDir).find((e) => e.id === m.id);
    expect(loaded!.trace_outcome).toBeNull();
    expect(loaded!.source_session_id).toBeNull();
  });

  // T-crit: the v2 → v3 migration on existing data.
  it('migrates a v2 store with existing memories without data loss', () => {
    // Manually construct a v2-shaped store (no trace columns), insert a row,
    // then call initStore which should add the columns and preserve the row.
    const dbPath = path.join(tmpDir, 'hippo.db');
    const db = new DatabaseSync(dbPath);
    // v2 minimal schema — mirror the production v2 CREATE TABLE exactly.
    db.exec(`
      CREATE TABLE schema_meta (version INTEGER);
      INSERT INTO schema_meta VALUES (2);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        created TEXT, last_retrieved TEXT, retrieval_count INTEGER,
        strength REAL, half_life_days REAL, layer TEXT,
        tags_json TEXT, emotional_valence TEXT, schema_fit REAL,
        source TEXT, outcome_score REAL, outcome_positive INTEGER,
        outcome_negative INTEGER, conflicts_with_json TEXT,
        pinned INTEGER, confidence TEXT, content TEXT,
        parents_json TEXT, starred INTEGER
      );
      INSERT INTO memories (id, created, last_retrieved, retrieval_count, strength,
        half_life_days, layer, tags_json, emotional_valence, schema_fit, source,
        outcome_score, outcome_positive, outcome_negative, conflicts_with_json,
        pinned, confidence, content, parents_json, starred)
      VALUES ('mem_legacy_v2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0,
        1.0, 7.0, 'episodic', '[]', 'neutral', 0.0, 'test', NULL, 0, 0, '[]',
        0, 'verified', 'pre-migration content body long enough to pass checks', '[]', 0);
    `);
    db.close();

    // Now initStore should migrate to v3.
    initStore(tmpDir);
    const loaded = loadAllEntries(tmpDir).find((e) => e.id === 'mem_legacy_v2');
    expect(loaded).toBeDefined();
    expect(loaded!.content).toContain('pre-migration content body');
    expect(loaded!.trace_outcome).toBeNull();
    expect(loaded!.source_session_id).toBeNull();
  });
});
