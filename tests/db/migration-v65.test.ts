// Schema v65 keys each stored text for rejection: every writer keeps the keys exact or clears them, and the sleep
// fill keys what a 2.x write or the upgrade left. One cell per writer, each with merged-bullet text.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { v65 } from '../../src/db/migrations/v65.js';
import { DAG_LEVEL, type MemoryEntry } from '../../src/base/memory/entry.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { otherDigests, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { upsertEntryRow, updateMemoryRows } from '../../src/store/sqlite/entry-row.js';
import { insertDormantRow, replaceDormantEntry } from '../../src/store/sqlite/dormant-rows.js';
import { settleSummary } from '../../src/store/sqlite/consolidation-summaries.js';
import { archiveRawMemory } from '../../src/store/sqlite/raw-archive.js';
import { expireDormantBefore } from '../../src/store/sqlite/dormant.js';
import { fillRejectionDigests } from '../../src/store/sqlite/text-digests.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';

const MERGED = mergedText('[Merged 2 related memories]', ['lint runs on push', 'the cache lives in /var']);
const OTHER = mergedText('[Merged 2 related memories]', ['tests run on merge', 'logs go to /srv']);
const V65_OBJECTS = {
  trigger: [
    'memories_rejection_digest_stale',
    'memories_held_digests_edit',
    'memories_held_digests_gone',
    'dormant_memories_rejection_digest_stale',
    'dormant_memories_held_digests_edit',
    'dormant_memories_held_digests_gone',
  ],
  index: [
    'idx_memories_rejection_digest',
    'idx_dormant_memories_rejection_digest',
    'idx_memories_artifact_ref',
    'idx_memories_artifact_created',
    'idx_session_owners_created_at',
  ],
};

type Keys = { digest: string | null; keys: string[] };

async function withDb(fn: (db: DatabaseSyncLike) => void | Promise<void>): Promise<void> {
  const db = openHippoDb(makeRoot('migration-v65'));
  try {
    await fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Takes a current store back to v64's shape. */
function toV64(db: DatabaseSyncLike): void {
  for (const name of V65_OBJECTS.trigger) db.exec(`DROP TRIGGER ${name}`);
  for (const name of V65_OBJECTS.index) db.exec(`DROP INDEX ${name}`);
  db.exec('DROP TABLE held_text_digests');
  db.exec('ALTER TABLE memories DROP COLUMN rejection_digest');
  db.exec('ALTER TABLE dormant_memories DROP COLUMN rejection_digest');
  db.exec('CREATE INDEX idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL');
}

/** A row's digest column and held keys; `inDormant` 1 reads dormant_memories. */
function keysOf(db: DatabaseSyncLike, id: string, inDormant: 0 | 1 = 0, tenantId = 'default'): Keys {
  const table = inDormant ? 'dormant_memories' : 'memories';
  // SAFETY: the SELECT names one nullable TEXT column, rejection_digest.
  const row = db.prepare(`SELECT rejection_digest FROM ${table} WHERE tenant_id = ? AND id = ?`).get(tenantId, id) as
    | { rejection_digest: string | null }
    | undefined;
  // SAFETY: the SELECT names one TEXT column, rejection_digest.
  const keys = db
    .prepare(
      `SELECT rejection_digest FROM held_text_digests WHERE tenant_id = ? AND memory_id = ? AND in_dormant = ? ` +
        `ORDER BY rejection_digest`,
    )
    .all(tenantId, id, inDormant) as Array<{ rejection_digest: string }>;
  return { digest: row?.rejection_digest ?? null, keys: keys.map((k) => k.rejection_digest) };
}

const exact = (text: string): Keys => ({ digest: rejectionDigest(text), keys: otherDigests(text) });
const noKeys: Keys = { digest: null, keys: [] };

function liveRow(db: DatabaseSyncLike, content = MERGED, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content), ...extra };
  upsertEntryRow(db, entry);
  return entry;
}

function dormantRow(db: DatabaseSyncLike, entry: MemoryEntry): void {
  insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: '2020-01-01T00:00:00.000Z' });
}

/** A 2.x INSERT: every column but the two keys, copied from `from`. */
function insertAs2x(db: DatabaseSyncLike, verb: string, row: { id: string; content: string }, from: string): void {
  // SAFETY: PRAGMA table_info answers one row per column with a TEXT name.
  const columns = (db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => !['id', 'content', 'rejection_digest', 'duplicate_hash'].includes(c));
  db.prepare(
    `${verb} INTO memories (id, content, ${columns.join(', ')}) SELECT ?, ?, ${columns.join(', ')} FROM memories WHERE id = ?`,
  ).run(row.id, row.content, from);
}

describe('migration v65', () => {
  it('adds only objects, and the fill keys each row once', async () => {
    await withDb((db) => {
      const merged = liveRow(db);
      const plain = liveRow(db, 'plain text with no bullets');
      dormantRow(db, createMemory(OTHER));
      toV64(db);
      // SAFETY: the SELECT answers one INTEGER column, n.
      const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
      const before = changes();
      v65.up(db);
      v65.up(db);
      expect(changes()).toBe(before);
      // SAFETY: the SELECT names one TEXT column, name.
      const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{
        name: string;
      }>;
      expect(indexes.map((i) => i.name)).not.toContain('idx_memories_current');
      expect(keysOf(db, merged.id)).toEqual(noKeys);
      expect(fillRejectionDigests(db)).toBe(3);
      expect(keysOf(db, merged.id)).toEqual(exact(MERGED));
      expect(keysOf(db, plain.id)).toEqual({ digest: rejectionDigest(plain.content), keys: [] });
      expect(fillRejectionDigests(db)).toBe(0);
    });
  });

  it('keeps the keys exact through every 3.0 writer', async () => {
    await withDb((db) => {
      const inserted = liveRow(db);
      expect(keysOf(db, inserted.id), 'insert').toEqual(exact(MERGED));
      upsertEntryRow(db, { ...inserted, content: OTHER });
      expect(keysOf(db, inserted.id), 'upsert update').toEqual(exact(OTHER));
      updateMemoryRows(db, [{ ...inserted, content: MERGED }]);
      expect(keysOf(db, inserted.id), 'chunk update').toEqual(exact(MERGED));

      const summary = liveRow(db, 'old summary', { dagLevel: DAG_LEVEL.topic });
      db.prepare('UPDATE memories SET summary_dirty = 1 WHERE id = ?').run(summary.id);
      const fields = { descendantCount: 2, earliestAt: null, latestAt: null };
      const settle = { id: summary.id, tenantId: 'default', actor: 't', audit: [] };
      const rebuiltAt = '2026-01-01T00:00:00.000Z';
      settleSummary(db, { ...settle, fields: { ...fields, content: { text: MERGED, rebuiltAt } } });
      expect(keysOf(db, summary.id), 'settle').toEqual(exact(MERGED));

      const asleep = createMemory(MERGED);
      dormantRow(db, asleep);
      expect(keysOf(db, asleep.id, 1), 'dormant insert').toEqual(exact(MERGED));
      dormantRow(db, { ...asleep, content: OTHER });
      expect(keysOf(db, asleep.id, 1), 'refresh').toEqual(exact(OTHER));
      const successor = { ...asleep, id: 'successor-id', content: MERGED };
      replaceDormantEntry(db, 'default', asleep.id, successor);
      expect(keysOf(db, asleep.id, 1), 'id replace, old id').toEqual(noKeys);
      expect(keysOf(db, successor.id, 1), 'id replace').toEqual(exact(MERGED));
    });
  });

  it('clears the keys a 2.x write leaves stale, and the fill writes them again', async () => {
    await withDb((db) => {
      const edited = liveRow(db);
      db.prepare('UPDATE memories SET content = ? WHERE id = ?').run(OTHER, edited.id);
      expect(keysOf(db, edited.id), '2.x update').toEqual(noKeys);
      insertAs2x(db, 'INSERT', { id: 'from-2x', content: MERGED }, edited.id);
      expect(keysOf(db, 'from-2x'), '2.x insert').toEqual(noKeys);
      const asleep = createMemory(MERGED);
      dormantRow(db, asleep);
      db.prepare('UPDATE dormant_memories SET id = ? WHERE id = ?').run('moved-2x', asleep.id);
      expect(keysOf(db, asleep.id, 1), '2.x dormant id move, old id').toEqual(noKeys);
      expect(keysOf(db, 'moved-2x', 1), '2.x dormant id move').toEqual(noKeys);

      const replaced = liveRow(db);
      insertAs2x(db, 'INSERT OR REPLACE', { id: replaced.id, content: OTHER }, replaced.id);
      expect(keysOf(db, replaced.id), 'INSERT OR REPLACE').toEqual({ digest: null, keys: otherDigests(MERGED) });

      fillRejectionDigests(db);
      expect(keysOf(db, edited.id)).toEqual(exact(OTHER));
      expect(keysOf(db, 'from-2x')).toEqual(exact(MERGED));
      expect(keysOf(db, 'moved-2x', 1)).toEqual(exact(MERGED));
      expect(keysOf(db, replaced.id), 'INSERT OR REPLACE, filled').toEqual(exact(OTHER));
    });
  });

  it("drops the keys of a row that goes, and only that tenant's", async () => {
    await withDb(async (db) => {
      const deleted = liveRow(db);
      db.prepare('DELETE FROM memories WHERE id = ?').run(deleted.id);
      expect(keysOf(db, deleted.id), 'delete').toEqual(noKeys);
      const raw = liveRow(db, MERGED, { kind: 'raw' });
      expect(() => db.prepare('DELETE FROM memories WHERE id = ?').run(raw.id)).toThrow(/append-only/);
      expect(keysOf(db, raw.id), 'refused delete').toEqual(exact(MERGED));
      archiveRawMemory(db, raw.id, { reason: 'test', who: 't' });
      expect(keysOf(db, raw.id), 'raw archive').toEqual(noKeys);

      const shared = createMemory(MERGED);
      dormantRow(db, shared);
      dormantRow(db, { ...shared, tenantId: 'b' });
      db.prepare(`DELETE FROM dormant_memories WHERE tenant_id = 'default' AND id = ?`).run(shared.id);
      expect(keysOf(db, shared.id, 1), 'dormant delete').toEqual(noKeys);
      expect(keysOf(db, shared.id, 1, 'b'), 'the other tenant').toEqual(exact(MERGED));
      const budget = { holdMs: 1000, clock: () => Date.now(), pause: async () => {} };
      expect(await expireDormantBefore(db, '2021-01-01T00:00:00.000Z', { dryRun: false, budget })).toBe(1);
      expect(keysOf(db, shared.id, 1, 'b'), 'dormant expiry').toEqual(noKeys);
    });
  });
});
