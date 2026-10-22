// A rejection over a tenant larger than one page: the same removals as one whole scan, and a write that lands while
// the rows are walked cannot bring the value back.
import { beforeEach, describe, expect, it } from 'vitest';
import { RejectedValueError } from '../../src/base/errors/api-errors.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { insertDormantRow, readDormantSnapshot } from '../../src/store/sqlite/dormant-rows.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entry-writes.js';
import type { Rejection } from '../../src/store/port/rejections.js';
import { rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import type { OnHandle } from '../../src/store/sqlite/open.js';
import { sqliteRejections } from '../../src/store/sqlite/rejections.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, readEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const ROWS = 1100;
const VALUE = 'The deploy window is Friday afternoon';
const HEADER = '[Consolidated from 2 related memories, newest first]';
const OTHER = 'Release notes go out with every tagged build';

let root: string;
beforeEach(() => {
  root = makeRoot('rejection-pages');
});

// The walk's page read: a write that lands as it is first prepared lands while the rows are walked with no lock held.
const WALK_PAGE = 'SELECT id, content, source, scope, created FROM memories ';

/** hippo.db's rejections on handles that call `onWalk` once, as the walk prepares its first page read. */
function rejectionsWalking(onWalk: () => void) {
  const handles = handlesOf(root);
  const { on } = handles;
  let fired = false;
  const pausing = (db: DatabaseSyncLike): DatabaseSyncLike => ({
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      if (!fired && sql.startsWith(WALK_PAGE)) {
        fired = true;
        onWalk();
      }
      return db.prepare(sql);
    },
    close: () => db.close(),
    function: (name, options, fn) => db.function(name, options, fn),
    aggregate: (name, options) => db.aggregate(name, options),
  });
  const walking: OnHandle = (fn, open) => on((db, files) => fn(pausing(db), files), open);
  return sqliteRejections({ ...handles, on: walking });
}

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Live rows that differ from a plain filler row, by their place in store order. */
const SPECIAL: ReadonlyMap<number, Partial<MemoryEntry>> = new Map<number, Partial<MemoryEntry>>([
  [2, { content: VALUE }],
  [600, { content: '  the DEPLOY window is friday   afternoon ' }],
  [700, { content: VALUE, kind: 'raw' }],
  [800, { content: mergedText(HEADER, [VALUE, OTHER]), source: 'consolidation', layer: Layer.Semantic }],
  [900, { content: VALUE, scope: 'personal:private:someone-else' }],
  [1000, { content: VALUE, tenantId: 'other' }],
]);

function seed(): string[] {
  const ids: string[] = [];
  withDb((db) => {
    db.exec('BEGIN');
    try {
      for (let i = 0; i < ROWS; i++) {
        const extra = SPECIAL.get(i) ?? {};
        const base = createMemory(extra.content ?? `filler row ${i} about topic ${i % 7}`, { tags: [] });
        const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        writeEntryDbOnly(db, { ...base, ...extra, created });
        ids.push(base.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  return ids;
}

function seedDormant() {
  const rows = {
    direct: createMemory(VALUE, { tags: [] }),
    merged: createMemory(mergedText(HEADER, [OTHER, VALUE]), { source: 'consolidation', layer: Layer.Semantic }),
    unrelated: createMemory('an unrelated dormant lesson about cron', { tags: [] }),
  };
  withDb((db) => {
    for (const entry of Object.values(rows)) {
      insertDormantRow(db, { entry, strength: 0.1, reason: 'decay', dormantAt: '2026-03-01T00:00:00.000Z' });
    }
  });
  return { direct: rows.direct.id, merged: rows.merged.id, unrelated: rows.unrelated.id };
}

function rejection(over: Partial<Rejection> = {}): Rejection {
  return {
    tenantId: 'default',
    actor: 'tester',
    reason: 'wrong',
    value: VALUE,
    ownScope: null,
    ...over,
  };
}

describe('rejections.apply across pages', () => {
  it('removes every holder in reach, live or dormant, whole or merged, as one whole scan did', async () => {
    const ids = seed();
    const dormant = seedDormant();

    const applied = await sqliteStore(root).rejections.apply(rejection());

    const removed = [ids[2], ids[600], ids[700], ids[800], dormant.direct, dormant.merged];
    expect(applied.removedIds).toEqual(removed);
    expect(applied.removedRawIds).toEqual([ids[700]]);
    expect(applied.successorIds).toHaveLength(1);
    expect(applied.dormantSuccessorIds).toHaveLength(1);
    const successor = readEntry(root, applied.successorIds[0], 'default');
    expect(successor?.content).toBe(mergedText('[Consolidated from 1 related memory, newest first]', [OTHER]));
    for (const id of [ids[2], ids[600], ids[800]]) expect(readEntry(root, id)).toBeNull();
    for (const id of [ids[900], ids[1000], ids[5]]) expect(readEntry(root, id)).not.toBeNull();
    expect(loadAllEntries(root, 'default')).toHaveLength(ROWS - 1 - 4 + 1);
    withDb((db) => {
      expect(readDormantSnapshot(db, 'default', dormant.direct)).toBeNull();
      expect(readDormantSnapshot(db, 'default', dormant.merged)).toBeNull();
      expect(readDormantSnapshot(db, 'default', applied.dormantSuccessorIds[0])?.entry.content).toBe(
        mergedText('[Consolidated from 1 related memory, newest first]', [OTHER]),
      );
      expect(readDormantSnapshot(db, 'default', dormant.unrelated)).not.toBeNull();
      expect(queryAuditEvents(db, { tenantId: 'default', op: 'reject_value' })).toMatchObject([
        { metadata: { digest: rejectionDigest(VALUE), removedIds: removed, count: removed.length } },
      ]);
    });
  });

  it('refuses a holder written after the rejected value commits and before the walk, while other writes land', async () => {
    const ids = seed();
    const late = { holder: createMemory(VALUE, { tags: [] }), other: createMemory('a lesson written mid-walk') };
    let refused: unknown;
    const applied = await rejectionsWalking(() => {
      // No wait for a lock: a write scope held across the walk would fail this write with SQLITE_BUSY.
      withDb((db) => {
        db.exec('PRAGMA busy_timeout = 0');
        writeEntryDbOnly(db, late.other);
        try {
          writeEntryDbOnly(db, late.holder);
        } catch (error) {
          refused = error;
        }
      });
    }).apply(rejection());

    expect(refused).toBeInstanceOf(RejectedValueError);
    expect(readEntry(root, late.holder.id)).toBeNull();
    expect(readEntry(root, late.other.id)?.content).toBe('a lesson written mid-walk');
    expect(applied.removedIds).toEqual([ids[2], ids[600], ids[700], ids[800]]);
    const holding = loadAllEntries(root, 'default').filter(
      (e) => rejectionDigest(e.content) === rejectionDigest(VALUE),
    );
    expect(holding.map((e) => e.id)).toEqual([ids[900]]);
  });
});
