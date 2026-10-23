// Schema v63 indexes the memories that hold conflict refs, so the conflict refresh reads those rows, not every memory,
// and recall traces by ts for their prune (tests/db/recall-trace-prune.test.ts).
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeHippoDb, getSchemaVersion, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { v63 } from '../../src/db/migrations/v63.js';
import { serializeEntry } from '../../src/base/memory/markdown.js';
import { shareMemory } from '../../src/domain/sharing/share.js';
import { layerDir } from '../../src/store/sqlite/mirrors.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { LATEST_SCHEMA_VERSION } from '../_helpers/schema-version.js';
import { sharingStores } from '../_helpers/sharing-stores.js';
import { readEntry, replaceDetectedConflicts, writeEntriesTogether } from '../_helpers/root-forms.js';

const CONFLICTED = 'idx_memories_conflicted';
const TRACES_BY_TS = 'idx_recall_traces_ts';
const BOTH = [CONFLICTED, TRACES_BY_TS];
const REFRESH_READ = "conflicts_with_json != '[]'";

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function plan(db: DatabaseSyncLike, sql: string): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

function indexNames(db: DatabaseSyncLike): string[] {
  // SAFETY: one `name` TEXT column.
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

function refsOf(db: DatabaseSyncLike): Record<string, string> {
  // SAFETY: two TEXT columns.
  const rows = db
    .prepare(`SELECT id, conflicts_with_json FROM memories WHERE conflicts_with_json != '[]' ORDER BY id`)
    .all() as Array<{ id: string; conflicts_with_json: string }>;
  return Object.fromEntries(rows.map((r) => [r.id, r.conflicts_with_json]));
}

const entry = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(`conflict member ${id}`),
  id,
  ...extra,
});

// Three open pairs over five rows: a holds b and c, b and c hold a, d and e hold each other.
const PAIRS = [
  ['m_a', 'm_b'],
  ['m_a', 'm_c'],
  ['m_d', 'm_e'],
].map(([a, b]) => ({ memory_a_id: a, memory_b_id: b, reason: 'test', score: 0.9 }));

/** Copies `templateId`'s row under `n` fresh ids in one statement, so 10,000 rows seed in well under a second. */
function fill(db: DatabaseSyncLike, templateId: string, n: number): void {
  // SAFETY: pragma_table_info answers one TEXT `name` per column.
  const cols = (db.prepare(`SELECT name FROM pragma_table_info('memories')`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  const picks = cols.map((c) => (c === 'id' ? `printf('fill_%06d', n.i)` : `memories.${c}`)).join(', ');
  db.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) ` +
      `INSERT INTO memories (${cols.join(', ')}) SELECT ${picks} FROM memories, n WHERE memories.id = ?`,
  ).run(n, templateId);
}

/** Five rows in three open conflicts among `size` memories, after one refresh has settled their refs. */
function seededStore(size: number): string {
  const root = makeRoot('v63-flat');
  writeEntriesTogether(root, [...['m_a', 'm_b', 'm_c', 'm_d', 'm_e'].map((id) => entry(id)), entry('m_plain')]);
  withDb(root, (db) => fill(db, 'm_plain', size - 6));
  replaceDetectedConflicts(root, PAIRS);
  return root;
}

interface RefreshRead {
  readonly statements: readonly string[];
  readonly rowsRead: number;
  readonly plan: string;
  readonly memories: number;
}

function measureRefresh(size: number): RefreshRead {
  const root = seededStore(size);
  const { statements, rowsRead } = recordStatements(() => replaceDetectedConflicts(root, PAIRS));
  const read = statements.find((sql) => sql.includes(REFRESH_READ));
  if (read === undefined) throw new Error('the refresh did not prepare its conflicted-row read');
  return withDb(root, (db) => {
    // SAFETY: an aggregate with no GROUP BY always answers one row.
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number };
    expect(Object.keys(refsOf(db))).toEqual(['m_a', 'm_b', 'm_c', 'm_d', 'm_e']);
    return { statements, rowsRead, plan: plan(db, read), memories: n };
  });
}

describe('schema v63', () => {
  it('a fresh store has both indexes', () => {
    const root = makeRoot('v63-fresh');
    withDb(root, (db) => expect(indexNames(db)).toEqual(expect.arrayContaining(BOTH)));
  });

  it('reads the same statements and rows at 1,000 and 10,000 memories, with no scan of memories', () => {
    const small = measureRefresh(1000);
    const large = measureRefresh(10_000);
    expect([small.memories, large.memories]).toEqual([1000, 10_000]);
    expect(large.statements).toEqual(small.statements);
    expect(large.rowsRead).toBe(small.rowsRead);
    for (const read of [small, large]) {
      expect(read.plan).toMatch(new RegExp(`SCAN memories USING (COVERING )?INDEX ${CONFLICTED}`));
      expect(read.plan).not.toMatch(/SCAN memories(?! USING)/);
    }
  }, 60_000);

  it('clears refs a shared copy carries with no conflict row behind them', async () => {
    const local = makeRoot('v63-share-local');
    const global = makeRoot('v63-share-global');
    const held = entry('m_held', { conflictsWith: ['m_peer'] });
    writeEntriesTogether(local, [held]);
    const copy = await shareMemory(...sharingStores(local, global), held.id, {
      tenantId: 'default',
      force: true,
      skipEmbed: true,
    });
    if (copy === null) throw new Error('force should share the row');
    expect(withDb(global, refsOf)).toEqual({ [copy.id]: '["m_peer"]' });
    replaceDetectedConflicts(global, []);
    expect(withDb(global, refsOf)).toEqual({});
  });

  it('clears refs a markdown mirror brought in with no conflict row behind them', () => {
    const root = makeRoot('v63-markdown', { init: false });
    const mirrored = entry('m_mirrored', { conflictsWith: ['m_gone'] });
    mkdirSync(layerDir(root, mirrored.layer), { recursive: true });
    writeFileSync(join(layerDir(root, mirrored.layer), `${mirrored.id}.md`), serializeEntry(mirrored));
    expect(readEntry(root, mirrored.id)?.conflictsWith).toEqual(['m_gone']);
    replaceDetectedConflicts(root, []);
    expect(readEntry(root, mirrored.id)?.conflictsWith).toEqual([]);
  });

  it('upgrades a v62 store once, keeps every row, and a second run of v63 changes nothing', () => {
    const root = seededStore(20);
    const before = withDb(root, refsOf);
    withDb(root, (db) => {
      for (const name of BOTH) db.exec(`DROP INDEX ${name}`);
      db.prepare(`UPDATE meta SET value = '62' WHERE key = 'schema_version'`).run();
      db.exec('PRAGMA user_version = 62');
    });
    const creates = /CREATE INDEX IF NOT EXISTS (idx_memories_conflicted|idx_recall_traces_ts) /;
    const upgrade = recordStatements(() => withDb(root, (db) => [getSchemaVersion(db), indexNames(db)] as const));
    expect(countMatching(upgrade.statements, creates)).toBe(2);
    expect(upgrade.result[0]).toBe(LATEST_SCHEMA_VERSION);
    expect(upgrade.result[1]).toEqual(expect.arrayContaining(BOTH));
    const reopen = recordStatements(() => withDb(root, refsOf));
    expect(countMatching(reopen.statements, creates)).toBe(0);
    expect(reopen.result).toEqual(before);
    withDb(root, (db) => {
      const indexes = indexNames(db).sort();
      v63.up(db);
      expect(indexNames(db).sort()).toEqual(indexes);
    });
  });
});
