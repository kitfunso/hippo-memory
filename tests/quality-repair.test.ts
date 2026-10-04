import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairAutomaticMemories } from '../src/quality-repair.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { DatabaseSync } from '../src/db/sqlite.js';
import { readDormantSnapshot } from '../src/dormant.js';
import { findRejectedValue, rejectionDigest } from '../src/rejection.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { Layer, type MemoryEntry } from '../src/memory.js';
import { savePrediction } from '../src/predictions/store.js';
import { mergedText } from '../src/same-text.js';
import { restoreDormant, unreject, type Context } from '../src/api.js';
import { importForStore } from '../src/agent-memories/sync.js';
import { closeWorld, note, openWorld, projectNotes } from './_helpers/agent-memories-world.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-quality-repair-'));
  initStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function seed(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { source: 'capture', layer: Layer.Episodic }), ...extra };
  writeEntry(root, entry);
  return entry;
}

function withDb<T>(fn: (db: InstanceType<typeof DatabaseSync>) => T): T {
  const db = new DatabaseSync(join(root, 'hippo.db'));
  try { return fn(db); } finally { db.close(); }
}

const ctx = (): Context => ({ hippoRoot: root, tenantId: 'default', actor: { subject: 'test', role: 'admin' } });
const run = (apply = false) => repairAutomaticMemories(root, { tenantId: 'default', apply });

describe('recoverable automatic memory quality repair', () => {
  it('previews without writes, then preserves full history, refuses resync, and supports explicit recovery', () => {
    const bad = seed('Found local migration files to be', { retrieval_count: 7, tags: ['error', 'captured'] });
    const good = seed('Keep test schema setup outside production migrations because production applies every sorted migration.');
    const before = readFileSync(join(root, 'hippo.db'));
    expect(run()).toMatchObject({ supported: true, appliedIds: [], backup: null });
    expect(readFileSync(join(root, 'hippo.db'))).toEqual(before);
    expect(existsSync(join(root, 'backups'))).toBe(false);

    const applied = run(true);
    expect(applied.appliedIds).toEqual([bad.id]);
    expect(existsSync(applied.backup!)).toBe(true);
    expect(loadAllEntries(root).map((entry) => entry.id)).toEqual([good.id]);
    const restoredSnapshot = withDb((db) => readDormantSnapshot(db, 'default', bad.id));
    expect(restoredSnapshot?.entry).toMatchObject({ content: bad.content, retrieval_count: 7, tags: bad.tags, source: bad.source });
    expect(withDb((db) => findRejectedValue(db, 'default', rejectionDigest(bad.content)))).not.toBeNull();
    expect(() => writeEntry(root, createMemory(bad.content))).toThrow(/rejected value/);
    expect(() => restoreDormant(ctx(), bad.id)).toThrow(/rejected value/);
    expect(run(true)).toMatchObject({ appliedIds: [], backup: null });
    unreject(ctx(), rejectionDigest(bad.content));
    expect(restoreDormant(ctx(), bad.id)).toMatchObject({ id: bad.id, content: bad.content, retrieval_count: 7 });
  });

  it('keeps pinned, raw, imported and object-backed memories with their links', () => {
    const content = 'bump build 78 for codemagic deploy';
    const pinned = seed(content, { pinned: true });
    const raw = seed(content, { kind: 'raw' });
    const imported = seed(content, { tags: ['claude-code-memory'], source: 'agent-memory:claude-code:p-001/note.md#abc' });
    const prediction = savePrediction(root, 'default', { classTag: 'delivery', claimText: content });
    const result = run(true);
    expect(result.appliedIds).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pinned.id, protection: 'pinned' }),
      expect.objectContaining({ id: raw.id, protection: 'raw receipt' }),
      expect.objectContaining({ id: imported.id, protection: 'trusted imported note' }),
      expect.objectContaining({ id: prediction.memoryId, protection: 'backs an object' }),
    ]));
    expect(loadAllEntries(root)).toHaveLength(4);
    expect(withDb((db) => db.prepare('SELECT memory_id FROM predictions WHERE id = ?').get(prediction.id))).toEqual({ memory_id: prediction.memoryId });
  });

  it('flags ambiguity and mixed bundles while preserving complete parts and structured records', () => {
    const mixed = seed(mergedText('[Consolidated from 2 related memories, newest first]', [
      'Found local migration files to be', 'Production migrations must exclude test setup because sorted filenames control application order.',
    ]), { source: 'consolidation', layer: Layer.Semantic });
    const weak = seed('more detail soon');
    const trace = seed('succeeds (inserts or updates)', { source: 'auto-promote', trace_outcome: 'success', layer: Layer.Trace });
    const digest = seed('succeeds (inserts or updates)', { tags: ['session-digest'] });
    const result = run(true);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: mixed.id, disposition: 'review' }),
      expect.objectContaining({ id: weak.id, disposition: 'review' }),
    ]));
    expect(result.issues.map((issue) => issue.id)).not.toContain(trace.id);
    expect(result.issues.map((issue) => issue.id)).not.toContain(digest.id);
    expect(result.appliedIds).toEqual([]);
    expect(loadAllEntries(root)).toHaveLength(4);
  });

  it('quarantines a shared exact bundle only when every known constituent is defective', () => {
    const bad = seed(mergedText('[Consolidated from 2 related memories, newest first]', [
      'bump build 78 for codemagic deploy', 'bump build 79 for codemagic deploy',
    ]), { source: 'shared:phzse:2026-01-01', layer: Layer.Semantic });
    expect(run(true).appliedIds).toEqual([bad.id]);
    expect(withDb((db) => readDormantSnapshot(db, 'default', bad.id))?.entry.content).toBe(bad.content);
  });

  it('rolls back snapshots, tombstones and removal when audit fails', () => {
    const bad = seed('succeeds (inserts or updates)');
    withDb((db) => db.exec("CREATE TRIGGER refuse_repair_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'reject_value' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"));
    expect(() => run(true)).toThrow(/audit unavailable/);
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(bad.id);
    expect(withDb((db) => readDormantSnapshot(db, 'default', bad.id))).toBeNull();
    expect(withDb((db) => findRejectedValue(db, 'default', rejectionDigest(bad.content)))).toBeNull();
  });

  it('aborts before mutation if the consistent backup cannot be created', () => {
    const bad = seed('succeeds (inserts or updates)');
    writeFileSync(join(root, 'backups'), 'blocks the backup directory');
    expect(() => run(true)).toThrow();
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(bad.id);
    expect(withDb((db) => readDormantSnapshot(db, 'default', bad.id))).toBeNull();
  });

  it('repairs compatible historical tables without upgrading schema version', () => {
    const bad = seed('Found local migration files to be');
    withDb((db) => {
      db.exec('PRAGMA user_version = 48');
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('48', 'schema_version');
    });
    expect(run(true).appliedIds).toEqual([bad.id]);
    expect(withDb((db) => db.prepare('PRAGMA user_version').get())).toEqual({ user_version: 48 });
  });

  it('blocks a historical store missing a deletion guard dependency before any backup or migration', () => {
    seed('Found local migration files to be');
    withDb((db) => {
      db.exec('DROP TABLE customer_notes');
      db.exec('PRAGMA user_version = 43');
      db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('43', 'schema_version');
    });
    const before = readFileSync(join(root, 'hippo.db'));
    const result = run(true);
    expect(result).toMatchObject({ supported: false, appliedIds: [], backup: null });
    expect(result.blockers).toContain('missing table: customer_notes');
    expect(readFileSync(join(root, 'hippo.db'))).toEqual(before);
    expect(existsSync(join(root, 'backups'))).toBe(false);
    expect(withDb((db) => db.prepare('PRAGMA user_version').get())).toEqual({ user_version: 43 });
  });

  it('does not disclose the source text in its report and scopes repair to one tenant', () => {
    const mine = seed('succeeds (inserts or updates)');
    const other = seed(mine.content, { tenantId: 'other' });
    const result = run(true);
    expect(result.appliedIds).toEqual([mine.id]);
    expect(JSON.stringify(result)).not.toContain(mine.content);
    expect(loadAllEntries(root).map((entry) => entry.id)).toContain(other.id);
  });

  it('refuses unchanged note import after an earlier captured value was repaired', () => {
    const world = openWorld();
    try {
      const bad = createMemory('succeeds (inserts or updates)', { source: 'capture' });
      writeEntry(world.local, bad);
      repairAutomaticMemories(world.local, { tenantId: 'default', apply: true });
      note(projectNotes(world), 'result.md', bad.content);
      importForStore(world.local, { machine: world.machine });
      expect(loadAllEntries(world.local)).toEqual([]);
    } finally { closeWorld(world); }
  });
});
