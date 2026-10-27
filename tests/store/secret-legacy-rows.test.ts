// A row stored raw before the boundary is redacted at its next write: a sleep decay refresh and an outcome each leave memories, its full-text row and its mirror without the secret.
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { batchWriteAndDelete, commitInChunks } from '../../src/store/sqlite/delete-and-batch.js';
import { recoverDueMirrors } from '../../src/store/sqlite/due-mirrors.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { storeFilesOf } from '../_helpers/test-session.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { readEntry } from '../_helpers/root-forms.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';

const GHP = runtimeJoin('ghp_', 'q'.repeat(36));
const RAW = `the ci token is ${GHP}`;
const STORED = 'the ci token is [REDACTED]';

let root: string;
beforeEach(() => {
  root = makeRoot('secret-legacy');
});

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function mirrorFile(entry: MemoryEntry): string {
  return path.join(root, entry.layer, `${entry.id}.md`);
}

/** A row a release before the boundary wrote: raw in memories, its full-text row and its mirror. */
function plantLegacy(content: string): MemoryEntry {
  const entry = createMemory(content);
  withDb((db) => {
    upsertEntryRow(db, entry);
    db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(content, entry.id);
    db.prepare('DELETE FROM memories_fts WHERE id = ?').run(entry.id);
    db.prepare('INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)').run(entry.id, content, '');
  });
  fs.mkdirSync(path.dirname(mirrorFile(entry)), { recursive: true });
  fs.writeFileSync(mirrorFile(entry), `---\nid: ${entry.id}\n---\n\n${content}\n`);
  return { ...entry, content };
}

function rawCopies(): number {
  return withDb((db) => {
    const live = db.prepare('SELECT count(*) AS n FROM memories WHERE instr(content, ?) > 0').get(GHP) as { n: number };
    const fts = db.prepare('SELECT count(*) AS n FROM memories_fts WHERE instr(content, ?) > 0').get(GHP) as { n: number };
    return live.n + fts.n;
  });
}

describe('legacy raw rows', () => {
  it('a decay refresh redacts the row, its full-text row and its mirror', async () => {
    const legacy = plantLegacy(RAW);
    expect(rawCopies()).toBe(2);
    await withDb((db) =>
      commitInChunks(db, storeFilesOf(root), [{ refreshes: [{ id: legacy.id, strength: 0.4 }], writes: [], deletes: [], dormant: [] }], {
        snapshot: new Map(),
        budget: { holdMs: Infinity, clock: () => 0, pause: async () => {} },
      }),
    );
    expect(rawCopies()).toBe(0);
    expect(readEntry(root, legacy.id)?.content).toBe(STORED);
    expect(fs.readFileSync(mirrorFile(legacy), 'utf8')).not.toContain(GHP);
  });

  it('an outcome redacts the row, its full-text row and its mirror', async () => {
    const legacy = plantLegacy(RAW);
    await sqliteStore(root).entryWrites.applyOutcome({
      tenantId: legacy.tenantId,
      actor: 'tester',
      ownScope: null,
      role: 'admin',
      ids: [legacy.id],
      good: true,
    });
    expect(rawCopies()).toBe(0);
    withDb((db) => recoverDueMirrors(storeFilesOf(root), db, true));
    expect(fs.readFileSync(mirrorFile(legacy), 'utf8')).not.toContain(GHP);
  });

  it('a batch write over a raw base keeps a concurrent content edit', () => {
    const legacy = plantLegacy(RAW);
    const edited = 'the ci token moved to the vault';
    withDb((db) => db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(edited, legacy.id));
    withDb((db) =>
      batchWriteAndDelete(db, {
        files: storeFilesOf(root),
        toWrite: [{ ...legacy, strength: 0.3 }],
        toDeleteIds: [],
        opts: { snapshot: new Map([[legacy.id, legacy]]) },
      }),
    );
    const row = readEntry(root, legacy.id);
    expect(row?.content).toBe(edited);
    expect(row?.strength).toBe(0.3);
  });
});
