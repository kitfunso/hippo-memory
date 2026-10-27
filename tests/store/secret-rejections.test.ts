// Tombstones digest the stored form of a value, and every probe and sweep checks each form a copy may hold, so raw legacy rows and tombstones keep working.
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BadRequestError, RejectedValueError } from '../../src/base/errors/api-errors.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { insertDormantRow, readDormantSnapshot } from '../../src/store/sqlite/dormant-rows.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { insertRejectedValue, listRejectedValues } from '../../src/store/sqlite/rejection.js';
import { batchWriteAndDelete } from '../../src/store/sqlite/delete-and-batch.js';
import { listAuditEvents } from '../../src/store/sqlite/audit.js';
import { storeFilesOf } from '../_helpers/test-session.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import type { Rejection } from '../../src/base/ports/store/rejections.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { conflictLoserFate } from '../../src/domain/consolidate/conflicts.js';
import { replaceDetectedConflicts } from '../_helpers/root-forms-parts/conflicts.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { readEntry } from '../_helpers/root-forms.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';

const ghp = (fill: string): string => runtimeJoin('ghp_', fill.repeat(36));
const GHP = ghp('a');
const RAW = `the deploy key is ${GHP}`;
const STORED = 'the deploy key is [REDACTED]';

let root: string;
beforeEach(() => {
  root = makeRoot('secret-rejections');
});

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function rejection(over: Partial<Rejection>): Rejection {
  return { tenantId: 'default', actor: 'tester', reason: 'wrong', ownScope: null, ...over };
}

async function write(content: string): Promise<MemoryEntry> {
  const entry = createMemory(content);
  await sqliteStore(root).entryWrites.writeEntry({ entry, actor: 'tester' });
  return entry;
}

/** A row as a release before the boundary left it: raw text in memories, its full-text row and its mirror. */
function plantLegacy(content: string): MemoryEntry {
  const entry = createMemory(content);
  withDb((db) => {
    upsertEntryRow(db, entry);
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, entry.id);
    db.prepare('DELETE FROM memories_fts WHERE id = ?').run(entry.id);
    db.prepare('INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)').run(entry.id, content, '');
  });
  const dir = path.join(root, entry.layer);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${entry.id}.md`), `---\nid: ${entry.id}\n---\n\n${content}\n`);
  return entry;
}

function rawHolders(): string[] {
  return withDb((db) => {
    // SAFETY: each SELECT projects the id column only.
    const hits = [
      ...db.prepare('SELECT id FROM memories WHERE instr(content, ?) > 0').all(GHP),
      ...db.prepare('SELECT id FROM memories_fts WHERE instr(content, ?) > 0').all(GHP),
      ...db
        .prepare('SELECT id FROM dormant_memories WHERE instr(content, ?) > 0 OR instr(entry_json, ?) > 0')
        .all(GHP, GHP),
    ] as { id: string }[];
    return hits.map((h) => h.id);
  });
}

function mirrorText(entry: MemoryEntry): string | null {
  const file = path.join(root, entry.layer, `${entry.id}.md`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

describe('tombstones over secret text', () => {
  it('a tombstone made before the boundary still refuses the raw write', async () => {
    withDb((db) =>
      insertRejectedValue(db, {
        tenantId: 'default',
        digest: rejectionDigest(RAW),
        reason: 'legacy',
        rejectedBy: 'tester',
        rejectedAt: '2026-01-01T00:00:00.000Z',
        normalizedChars: RAW.length,
      }),
    );
    await expect(write(RAW)).rejects.toBeInstanceOf(RejectedValueError);
  });

  it('reject --value with a secret refuses a later write of the same text', async () => {
    await sqliteStore(root).rejections.apply(rejection({ value: RAW }));
    await expect(write(RAW)).rejects.toBeInstanceOf(RejectedValueError);
  });

  it('two values that differ only in their secret share one tombstone', async () => {
    const applied = await sqliteStore(root).rejections.apply(rejection({ value: RAW }));
    expect(applied.digest).toBe(rejectionDigest(STORED));
    await expect(write(`the deploy key is ${ghp('b')}`)).rejects.toBeInstanceOf(RejectedValueError);
  });

  it('refuses a value that is all secret, by value and by id, and writes no tombstone', async () => {
    const { rejections } = sqliteStore(root);
    await expect(rejections.apply(rejection({ value: ` ${GHP} ` }))).rejects.toThrow(/all secret.*hippo forget/);
    const row = await write(GHP);
    const byId = rejections.apply(rejection({ memoryId: row.id }));
    await expect(byId).rejects.toBeInstanceOf(BadRequestError);
    await expect(byId).rejects.toThrow(`hippo forget ${row.id}`);
    expect(withDb((db) => listRejectedValues(db, 'default'))).toEqual([]);
    expect(readEntry(root, row.id)).not.toBeNull();
  });

  it('reject --value with the raw secret purges a legacy row, its full-text row, mirror and dormant copy', async () => {
    const live = plantLegacy(RAW);
    const dormant = createMemory(RAW);
    withDb((db) => {
      insertDormantRow(db, { entry: dormant, strength: 0.1, reason: 'decay', dormantAt: '2026-03-01T00:00:00.000Z' });
      db.prepare('UPDATE dormant_memories SET content = ?, entry_json = replace(entry_json, ?, ?) WHERE id = ?').run(
        RAW,
        STORED,
        RAW,
        dormant.id,
      );
    });
    expect(rawHolders()).toEqual([live.id, live.id, dormant.id]);
    const applied = await sqliteStore(root).rejections.apply(rejection({ value: RAW }));
    expect(applied.removedIds).toEqual([live.id, dormant.id]);
    expect(rawHolders()).toEqual([]);
    expect(mirrorText(live)).toBeNull();
    expect(withDb((db) => readDormantSnapshot(db, 'default', dormant.id))).toBeNull();
  });

  it('a decay refresh of a legacy row a new tombstone matches is not refused and stores the stored form', () => {
    const live = plantLegacy(RAW);
    withDb((db) => {
      insertRejectedValue(db, {
        tenantId: 'default',
        digest: rejectionDigest(STORED),
        reason: 'new',
        rejectedBy: 'tester',
        rejectedAt: '2026-01-01T00:00:00.000Z',
        normalizedChars: STORED.length,
      });
      const loaded = { ...live, content: RAW };
      batchWriteAndDelete(db, {
        files: storeFilesOf(root),
        toWrite: [{ ...loaded, strength: 0.5 }],
        toDeleteIds: [],
        opts: { snapshot: new Map([[live.id, loaded]]) },
      });
    });
    expect(readEntry(root, live.id)?.content).toBe(STORED);
    expect(rawHolders()).toEqual([]);
    expect(mirrorText(live)).not.toContain(GHP);
  });

  it('a conflict loser that is all secret is removed with no tombstone, and the audit row says why', async () => {
    const keep = await write('the deploy key lives in the vault');
    const loser = await write(GHP);
    replaceDetectedConflicts(root, [{ memory_a_id: keep.id, memory_b_id: loser.id, reason: 'differs', score: 1 }]);
    const { conflicts } = sqliteStore(root);
    const [row] = (await conflicts.list({ tenantId: 'default', status: 'open', limit: 10 })).rows;
    const loserSide = { id: loser.id, scope: null };
    const resolved = await conflicts.resolve('default', {
      conflictId: row!.conflict.id,
      keep: { id: keep.id, scope: null },
      loser: loserSide,
      fate: conflictLoserFate({ rejectLoser: true }, loserSide, null),
      actor: 'tester',
      reason: 'wrong',
      at: new Date().toISOString(),
    });
    expect(resolved).toBe(true);
    expect(readEntry(root, loser.id)).toBeNull();
    expect(withDb((db) => listRejectedValues(db, 'default'))).toEqual([]);
    const [event] = withDb((db) => listAuditEvents(db, { tenantId: 'default', op: 'conflict_resolve' }));
    expect(event?.metadata).toMatchObject({ rejected: true, tombstoneSkipped: 'all-secret' });
  });
});
