// Session assemble's reads seek what they need: the content read probes the asked ids, the key and count reads the session.
import { afterEach, describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) removeDir(r);
});

function row(i: number, session: string): MemoryEntry {
  return {
    ...createMemory(`message body number ${i} with some words to fill a line`, {
      layer: Layer.Buffer,
      kind: 'raw',
      sourceSessionId: session,
    }),
    id: `${session}-${String(i).padStart(5, '0')}`,
    created: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
  };
}

/** A store with a five-row session `s1` and `others` rows of other sessions in the same tenant. */
function seeded(others: number): string {
  const root = makeRoot('session-raw-plan');
  roots.push(root);
  writeEntriesTogether(root, [
    ...Array.from({ length: 5 }, (_, i) => row(i, 's1')),
    ...Array.from({ length: others }, (_, i) => row(i, 'other')),
  ]);
  return root;
}

const QUERY = { tenantId: 'default', sessionId: 's1' } as const;
const IDS = ['s1-00001', 's1-00003'];

interface Reads {
  readonly sql: Record<'rows' | 'keys' | 'count', string>;
  readonly rows: number;
}

async function sessionReads(root: string): Promise<Reads> {
  const { dagReads } = sqliteStore(root);
  const log = await recordStatementsAsync(async () => {
    await dagReads.sessionRawRows({ ...QUERY, ids: IDS });
    await dagReads.sessionRawKeys({ ...QUERY, limit: 10 });
    await dagReads.sessionRawCount(QUERY);
  });
  const find = (pattern: RegExp): string => {
    const sql = log.statements.find((s) => pattern.test(s));
    if (sql === undefined) throw new Error(`no statement matched ${pattern}`);
    return sql;
  };
  const content = find(/json_each/);
  return {
    sql: {
      rows: content,
      keys: find(/length\(content\)/),
      count: find(/^SELECT COUNT\(\*\) AS c FROM memories WHERE kind = 'raw'/),
    },
    rows: log.reads.filter((r) => r.sql === content).reduce((sum, r) => sum + r.rows, 0),
  };
}

function plan(root: string, sql: string): string {
  const db = openHippoDb(root);
  try {
    const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 'x');
    // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(' | ');
  } finally {
    closeHippoDb(db);
  }
}

describe('session raw read plans', () => {
  it('reads content by primary key lookups of the asked ids, never a tenant index scan', async () => {
    const root = seeded(50);
    const p = plan(root, (await sessionReads(root)).sql.rows);
    expect(p).toMatch(/SEARCH memories USING INDEX sqlite_autoindex_memories_1 \(id=\?\)/);
    expect(p).not.toContain('idx_memories_tenant');
  });

  it('reads keys and the count off the session index', async () => {
    const root = seeded(50);
    const { sql } = await sessionReads(root);
    for (const s of [sql.keys, sql.count]) {
      const p = plan(root, s);
      expect(p).toContain('idx_memories_source_session_id');
      expect(p).not.toMatch(/SCAN memories(?! USING)/);
    }
  });

  it('hands back only the asked rows however large the tenant grows', async () => {
    const small = await sessionReads(seeded(10));
    const large = await sessionReads(seeded(400));
    expect(small.rows).toBe(IDS.length);
    expect(large.rows).toBe(IDS.length);
  });
});
