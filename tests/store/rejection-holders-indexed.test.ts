// A rejection reads the rows that may hold a value by their keys, and removes exactly the rows a walk of both tables
// would: one cell per way a row comes to hold the text, each checked against that walk. Real store.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { v65 } from '../../src/db/migrations/v65.js';
import { DAG_LEVEL, type MemoryEntry } from '../../src/base/memory/entry.js';
import { heldTexts, mergedText } from '../../src/base/util/same-text.js';
import { contentDigests, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { redactSecretsStrict } from '../../src/base/util/secret-detect.js';
import { rejectionReaches } from '../../src/base/records/rejection-text.js';
import { ownScopeTouches } from '../../src/base/scope/recall-scope.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { insertDormantRow, replaceDormantEntry, deleteDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { settleSummary } from '../../src/store/sqlite/consolidation-summaries.js';
import { fillRejectionDigests } from '../../src/store/sqlite/text-digests.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { listMemoryConflicts, replaceDetectedConflicts } from '../_helpers/root-forms.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

const V = 'the deploy key rotates on friday';
const GHP = runtimeJoin('ghp_', 'a'.repeat(36));
const SECRET = `the deploy key is ${GHP}`;
const TWIN = `the deploy key is ${runtimeJoin('ghp_', 'b'.repeat(36))}`;
const merged = (...texts: string[]): string => mergedText('[Merged 2 related memories]', texts);
const BOB = 'personal:private:bob';
const DORMANT_AT = '2020-01-01T00:00:00.000Z';

/** One way a row comes to hold (or seem to hold) the value; `build` writes it on an open handle. */
interface Cell {
  readonly name: string;
  readonly value?: string;
  readonly tenantId?: string;
  /** The ids the walk must find, so a cell that seeds nothing cannot pass. */
  readonly holders: number;
  readonly build: (db: DatabaseSyncLike) => void;
}

const live = (db: DatabaseSyncLike, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => {
  const entry = { ...createMemory(content), ...extra };
  upsertEntryRow(db, entry);
  return entry;
};
const dormant = (db: DatabaseSyncLike, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => {
  const entry = { ...createMemory(content, { source: 'consolidation' }), ...extra };
  insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: DORMANT_AT });
  return entry;
};

/** Runs `v64` on a store taken back to schema v64, then v65 and the fill: a row a 2.x binary wrote. */
function legacy(db: DatabaseSyncLike, v64: () => void): void {
  for (const table of ['memories', 'dormant_memories']) {
    for (const t of ['rejection_digest_stale', 'held_digests_edit', 'held_digests_gone']) {
      db.exec(`DROP TRIGGER ${table}_${t}`);
    }
    db.exec(`DROP INDEX idx_${table}_rejection_digest`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN rejection_digest`);
  }
  db.exec('DROP TABLE held_text_digests');
  v64();
  v65.up(db);
  fillRejectionDigests(db);
}

/** A 2.x INSERT: every column but the two keys, copied from row `from`. */
function insertAs2x(db: DatabaseSyncLike, verb: string, row: { id: string; content: string }, from: string): void {
  // SAFETY: PRAGMA table_info answers one row per column with a TEXT name.
  const columns = (db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>)
    .map((c) => c.name)
    .filter((c) => !['id', 'content', 'rejection_digest', 'duplicate_hash'].includes(c));
  db.prepare(
    `${verb} INTO memories (id, content, ${columns.join(', ')}) SELECT ?, ?, ${columns.join(', ')} FROM memories WHERE id = ?`,
  ).run(row.id, row.content, from);
}

const CELLS: readonly Cell[] = [
  { name: 'whole exact (W)', holders: 1, build: (db) => void live(db, V) },
  { name: 'case (W)', holders: 1, build: (db) => void live(db, 'The Deploy KEY rotates on Friday') },
  { name: 'spacing (W)', holders: 1, build: (db) => void live(db, 'the  deploy key\trotates on friday') },
  {
    name: 'mergedText (W)',
    holders: 1,
    build: (db) => void live(db, merged(V, 'lint runs on push'), { source: 'consolidation' }),
  },
  {
    name: 'legacy merged format (F)',
    holders: 1,
    build: (db) => {
      const row = live(db, 'placeholder');
      legacy(db, () => {
        const text = `[Consolidated from 2 related memories]\n\n${V}`;
        db.prepare(`UPDATE memories SET content = ?, source = 'consolidation' WHERE id = ?`).run(text, row.id);
      });
    },
  },
  { name: 'dormant whole (W)', holders: 1, build: (db) => void dormant(db, V) },
  { name: 'dormant merged (W)', holders: 1, build: (db) => void dormant(db, merged(V, 'lint runs on push')) },
  {
    name: 'dormant merged after an id move (W)',
    holders: 1,
    build: (db) => {
      const row = dormant(db, 'placeholder');
      replaceDormantEntry(db, 'default', row.id, { ...row, id: 'moved-id', content: merged(V, 'logs go to /srv') });
    },
  },
  {
    name: 'settled summary (W)',
    holders: 1,
    build: (db) => {
      const summary = live(db, 'old summary', { dagLevel: DAG_LEVEL.topic, source: 'consolidation' });
      db.prepare('UPDATE memories SET summary_dirty = 1 WHERE id = ?').run(summary.id);
      const content = { text: merged(V, 'tests run on merge'), rebuiltAt: DORMANT_AT };
      const fields = { content, descendantCount: 2, earliestAt: null, latestAt: null };
      settleSummary(db, { id: summary.id, tenantId: 'default', actor: 't', audit: [], fields });
    },
  },
  {
    name: 'legacy raw secret, and a twin with another secret (F)',
    value: SECRET,
    holders: 2,
    build: (db) => {
      const rows = [live(db, 'placeholder one'), live(db, 'placeholder two')];
      legacy(db, () => {
        const set = db.prepare('UPDATE memories SET content = ? WHERE id = ?');
        set.run(SECRET, rows[0].id);
        set.run(TWIN, rows[1].id);
      });
    },
  },
  {
    name: 'legacy unfilled (S)',
    holders: 1,
    build: (db) => insertAs2x(db, 'INSERT', { id: 'from-2x', content: V }, live(db, 'template').id),
  },
  {
    name: '2.x-edited whole and merged (S)',
    holders: 2,
    build: (db) => {
      const set = db.prepare('UPDATE memories SET content = ? WHERE id = ?');
      set.run(V, live(db, 'before the edit').id);
      set.run(merged(V, 'lint runs on push'), live(db, merged('a', 'b'), { source: 'consolidation' }).id);
    },
  },
  {
    name: '2.x dormant id move (S)',
    holders: 1,
    build: (db) => {
      const row = dormant(db, merged(V, 'lint runs on push'));
      // SAFETY: the SELECT names one TEXT column, entry_json.
      const { entry_json } = db.prepare('SELECT entry_json FROM dormant_memories WHERE id = ?').get(row.id) as {
        entry_json: string;
      };
      const moved = JSON.stringify({ ...JSON.parse(entry_json), id: 'moved-2x' });
      // replaceDormantEntry's statement as 2.x sends it, with no digest.
      db.prepare('UPDATE dormant_memories SET id = ?, content = ?, entry_json = ? WHERE tenant_id = ? AND id = ?').run(
        'moved-2x',
        row.content,
        moved,
        'default',
        row.id,
      );
    },
  },
  {
    name: 'keys left by INSERT OR REPLACE (S)',
    holders: 1,
    build: (db) => {
      const row = live(db, merged(V, 'lint runs on push'), { source: 'consolidation' });
      insertAs2x(db, 'INSERT OR REPLACE', { id: row.id, content: 'no longer the value' }, row.id);
      live(db, V);
    },
  },
  {
    name: 'same dormant id in another tenant (P)',
    tenantId: 'b',
    holders: 1,
    build: (db) => {
      const row = dormant(db, merged(V, 'lint runs on push'), { tenantId: 'b' });
      dormant(db, 'another text', { id: row.id });
      deleteDormantRow(db, 'default', row.id);
      const plant = db.prepare('INSERT INTO held_text_digests VALUES (?, ?, 1, ?)');
      plant.run('b', rejectionDigest(V), 'no-such-row');
    },
  },
  {
    name: 'out of reach, bullets on a non-merged row (W)',
    holders: 1,
    build: (db) => {
      live(db, V, { scope: BOB });
      live(db, `Release steps\n\n- ${V}\n- push the tag`, { source: 'cli' });
      live(db, V);
    },
  },
];

interface TextRow {
  readonly id: string;
  readonly content: string;
  readonly source: string | null;
  readonly scope: string | null;
}

/** Every row of `tenantId` in `table`, read in full. */
function allRows(db: DatabaseSyncLike, table: 'memories' | 'dormant_memories', tenantId: string): TextRow[] {
  const columns =
    table === 'memories'
      ? 'id, content, source, scope'
      : `id, content, json_extract(entry_json, '$.source') AS source, json_extract(entry_json, '$.scope') AS scope`;
  // SAFETY: both column lists answer id, content, source and scope.
  return db.prepare(`SELECT ${columns} FROM ${table} WHERE tenant_id = ?`).all(tenantId) as unknown as TextRow[];
}

/** Oracle A: both tables in full, the reach and the predicate, as apply's removal judges each row. */
function applyOracle(db: DatabaseSyncLike, tenantId: string, value: string): string[] {
  const holds = (text: string) => contentDigests(text).includes(rejectionDigest(redactSecretsStrict(value)));
  const held = (row: TextRow) =>
    holds(row.content) || heldTexts({ content: row.content, source: row.source ?? '' }).some(holds);
  return [...allRows(db, 'memories', tenantId), ...allRows(db, 'dormant_memories', tenantId)]
    .filter((row) => rejectionReaches(null, row.scope) && held(row))
    .map((row) => row.id)
    .sort();
}

function seeded(cell: Cell, fillers = 3): string {
  const root = makeRoot('rejection-holders');
  const db = openHippoDb(root);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < fillers; i++) live(db, `filler row ${i} about the quux client`);
    db.exec('COMMIT');
    cell.build(db);
  } finally {
    closeHippoDb(db);
  }
  return root;
}

function oracleOn(root: string, oracle: (db: DatabaseSyncLike) => string[]): string[] {
  const db = openHippoDb(root);
  try {
    return oracle(db);
  } finally {
    closeHippoDb(db);
  }
}

const rejection = (cell: Pick<Cell, 'value' | 'tenantId'>) => ({
  tenantId: cell.tenantId ?? 'default',
  actor: 'tester',
  reason: 'wrong',
  ownScope: null,
  value: cell.value ?? V,
});

describe('a rejection reads its holders by key', () => {
  it.each(CELLS)('removes what a walk of both tables finds: $name', async (cell) => {
    const root = seeded(cell);
    const expected = oracleOn(root, (db) => applyOracle(db, cell.tenantId ?? 'default', cell.value ?? V));
    expect(expected).toHaveLength(cell.holders);
    const applied = await sqliteStore(root).rejections.apply(rejection(cell));
    expect([...applied.removedIds].sort()).toEqual(expected);
  });
});

/** Seeds a conflict whose loser holds `value`, plus the cell's rows; returns the root and both sides. */
function conflictStore(cell: Cell, fillers = 3): { root: string; keep: string; loser: string } {
  const root = seeded(cell, fillers);
  const db = openHippoDb(root);
  let sides: { keep: string; loser: string };
  try {
    sides = { keep: live(db, 'keep this text').id, loser: live(db, cell.value ?? V).id };
  } finally {
    closeHippoDb(db);
  }
  replaceDetectedConflicts(root, [{ memory_a_id: sides.keep, memory_b_id: sides.loser, reason: 'r', score: 0.9 }]);
  return { root, ...sides };
}

/** Oracle B: live rows only, whole text, ownScopeTouches, less loser and keep. */
function resolveOracle(db: DatabaseSyncLike, value: string, sides: { keep: string; loser: string }): string[] {
  const digest = rejectionDigest(redactSecretsStrict(value));
  return allRows(db, 'memories', 'default')
    .filter((row) => row.id !== sides.keep && row.id !== sides.loser)
    .filter((row) => contentDigests(row.content).includes(digest) && ownScopeTouches(null, row.scope))
    .map((row) => row.id)
    .sort();
}

async function resolveReject(root: string, sides: { keep: string; loser: string }): Promise<boolean> {
  const [conflict] = await listMemoryConflicts(root, 'open');
  return sqliteStore(root).conflicts.resolve('default', {
    conflictId: conflict.id,
    keep: { id: sides.keep, scope: null },
    loser: { id: sides.loser, scope: null },
    fate: { kind: 'reject', ownScope: null },
    actor: 'tester',
    reason: 'wrong',
    at: DORMANT_AT,
  });
}

const LIVE_WHOLE = CELLS.filter((c) => !c.name.startsWith('dormant') && c.tenantId === undefined);

describe('a conflict resolved with reject reads the loser value by key', () => {
  it.each(LIVE_WHOLE)('removes the live whole copies a walk finds: $name', async (cell) => {
    const { root, ...sides } = conflictStore(cell);
    const expected = oracleOn(root, (db) => resolveOracle(db, cell.value ?? V, sides));
    const before = oracleOn(root, (db) => allRows(db, 'memories', 'default').map((r) => r.id));
    expect(await resolveReject(root, sides)).toBe(true);
    const after = new Set(oracleOn(root, (db) => allRows(db, 'memories', 'default').map((r) => r.id)));
    const gone = before.filter((id) => !after.has(id) && id !== sides.loser).sort();
    expect(gone).toEqual(expected);
  });
});

/** The production SQL a rejection's candidate read prepares, captured from a real apply. */
async function candidateSql(root: string): Promise<string[]> {
  const { statements } = await recordStatementsAsync(() => sqliteStore(root).rejections.apply(rejection({})));
  return [...new Set(statements.filter((sql) => /rejection_digest (=|IS NULL)/.test(sql)))];
}

function plan(db: DatabaseSyncLike, sql: string): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

describe('the candidate read is bounded by the holders, not the tenant', () => {
  const work = async (fillers: number) => {
    const cell = CELLS[3];
    const root = seeded(cell, fillers);
    const apply = await recordStatementsAsync(() => sqliteStore(root).rejections.apply(rejection({})));
    const { root: conflictRoot, ...sides } = conflictStore(cell, fillers);
    const resolve = await recordStatementsAsync(() => resolveReject(conflictRoot, sides));
    return [apply, resolve].map(({ rowsRead, statements }) => ({ rowsRead, statements: statements.length }));
  };

  it('reads the same rows and runs the same statements beside 100 rows or 600', async () => {
    expect(await work(600)).toEqual(await work(100));
  });

  it('seeks both digest indexes and the held keys, and scans none of the three tables', async () => {
    const root = seeded(CELLS[0]);
    const sqls = await candidateSql(root);
    const db = openHippoDb(root);
    try {
      const plans = sqls.map((sql) => plan(db, sql)).join(' || ');
      for (const index of ['idx_memories_rejection_digest', 'idx_dormant_memories_rejection_digest']) {
        expect(plans).toContain(index);
      }
      expect(plans).toMatch(/held_text_digests USING (PRIMARY KEY|INDEX)/);
      for (const table of ['memories', 'dormant_memories', 'held_text_digests']) {
        expect(plans).not.toMatch(new RegExp(`SCAN ${table}\\b`));
      }
    } finally {
      closeHippoDb(db);
    }
  });
});
