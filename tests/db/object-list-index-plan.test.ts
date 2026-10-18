// Object lists and the session-digest read run off the v56 indexes: no table scan and no sort step.

import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import { saveDecision, loadDecisions } from '../../src/objects/decisions.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import type { CreateMemoryOptions, MemoryEntry } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { LATEST_SCHEMA_VERSION_STR } from '../_helpers/schema-version.js';
import { makeRoot } from '../_helpers/make-root.js';
import { objectsAt } from '../_helpers/objects-at.js';
import { loadConfig } from '../../src/core/config.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';

const OBJECT_TABLES = ['decisions', 'incidents', 'processes', 'policies', 'skills', 'project_briefs', 'customer_notes'];
const NEW_INDEXES = [
  ...OBJECT_TABLES.map((t) => `idx_${t}_tenant_status_created`),
  'idx_memories_source_tenant_created',
];

const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(): string {
  const root = makeRoot('object-list-plan');
  roots.push(root);
  return root;
}

function plan(db: DatabaseSyncLike, sql: string, ...params: Array<string | number>): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

function indexNames(db: DatabaseSyncLike): string[] {
  // SAFETY: one `name` TEXT column.
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`).all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function withDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** The SQL the store really prepares for one call, picked out by a fragment only that statement holds. */
async function preparedSql(fn: () => void | Promise<void>, fragment: string): Promise<string> {
  const { statements } = await recordStatementsAsync(async () => {
    await fn();
  });
  const sql = statements.find((s) => s.includes(fragment));
  if (sql === undefined) throw new Error(`no statement holding ${fragment}`);
  return sql;
}

describe('object list query plan', () => {
  it('lists by status off the new index, with or without a cursor', async () => {
    const root = newRoot();
    for (const text of ['one', 'two', 'three']) {
      await saveDecision(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', {
        decisionText: `decide ${text}`,
      });
    }
    const first = (await loadDecisions(objectsAt(root), 'default', { status: 'active', limit: 1 }))[0]!;
    const listSql = await preparedSql(async () => {
      await loadDecisions(objectsAt(root), 'default', { status: 'active', limit: 2 });
    }, 'ORDER BY created_at DESC, id DESC');
    const pageSql = await preparedSql(async () => {
      await loadDecisions(objectsAt(root), 'default', {
        status: 'active',
        limit: 2,
        after: { key: first.createdAt, id: first.id },
      });
    }, '(created_at, id) < (?, ?)');
    withDb(root, (db) => {
      for (const detail of [
        plan(db, listSql, 'default', 'active', 2),
        plan(db, pageSql, 'default', 'active', first.createdAt, first.id, 2),
      ]) {
        expect(detail).toMatch(/USING (COVERING )?INDEX idx_decisions_tenant_status_created/);
        expect(detail).not.toContain('TEMP B-TREE');
        expect(detail).not.toMatch(/\bSCAN\b/);
      }
    });
  });

  it('gives every object table the same plan', () => {
    const root = newRoot();
    withDb(root, (db) => {
      for (const table of OBJECT_TABLES) {
        const detail = plan(
          db,
          `SELECT * FROM ${table} WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
          'default',
          'active',
          5,
        );
        expect(detail).toMatch(new RegExp(`USING (COVERING )?INDEX idx_${table}_tenant_status_created`));
        expect(detail).not.toContain('TEMP B-TREE');
      }
    });
  });

  it('pages in created_at then id order, ties included, at every page size', async () => {
    const root = newRoot();
    const saved = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((t) =>
        saveDecision(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'default', { decisionText: `tie ${t}` }),
      ),
    );
    await saveDecision(objectsAt(root), loadConfig(root).defaultHalfLifeDays, 'other', {
      decisionText: 'another tenant',
    });
    withDb(root, (db) => {
      db.prepare(`UPDATE decisions SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?, ?)`).run(
        saved[0]!.id,
        saved[2]!.id,
        saved[4]!.id,
      );
    });
    const all = await loadDecisions(objectsAt(root), 'default', { status: 'active', limit: 50 });
    const expected = [...all].sort((x, y) =>
      x.createdAt === y.createdAt ? y.id - x.id : x.createdAt < y.createdAt ? 1 : -1,
    );
    expect(all.map((d) => d.id)).toEqual(expected.map((d) => d.id));
    expect(all).toHaveLength(5);
    for (const size of [1, 2, 4, 5]) {
      const paged: number[] = [];
      let after: { key: string; id: number } | undefined;
      for (;;) {
        const page = await loadDecisions(objectsAt(root), 'default', { status: 'active', limit: size, after });
        paged.push(...page.map((d) => d.id));
        if (page.length < size) break;
        const last = page[page.length - 1]!;
        after = { key: last.createdAt, id: last.id };
      }
      expect(paged).toEqual(expected.map((d) => d.id));
    }
  });
});

describe('session digest read plan', () => {
  it('reads the digest rows through idx_memories_source_tenant_created, not the tenant walk', async () => {
    const root = newRoot();
    const sql = await preparedSql(() => {
      sqliteSyncStore(root).contextReads.liveContentsBySourceAndTag(
        'default',
        'session-digest',
        'session-digest',
        's1',
      );
    }, 'instr(tags_json, ?)');
    withDb(root, (db) => {
      const detail = plan(db, sql, 'default', 'session-digest', '"session-digest"', 's1');
      expect(detail).toContain('USING INDEX idx_memories_source_tenant_created (source=? AND tenant_id=?)');
      expect(detail).not.toContain('TEMP B-TREE');
    });
  });

  it('returns the same digests, in store order, as a filter over every row', () => {
    const root = newRoot();
    const digest = (
      content: string,
      extra: Partial<CreateMemoryOptions> = {},
      tags = ['session-digest'],
    ): MemoryEntry => createMemory(content, { source: 'session-digest', tags, sourceSessionId: 's2', ...extra });
    const entries = [
      digest('digest from another session'),
      digest('digest from this session', { sourceSessionId: 's1' }),
      digest('digest with no session', { sourceSessionId: null }),
      digest('digest extracted from a row', { extractedFrom: 'mem-x' }),
      digest('digest without the tag', {}, ['other']),
      digest('digest of another tenant', { tenantId: 'other' }),
      createMemory('tagged row from the cli', { tags: ['session-digest'] }),
      digest('second digest from another session'),
    ];
    for (const e of entries) writeEntry(root, e);
    withDb(root, (db) =>
      db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(entries[0]!.id, entries[7]!.id),
    );
    const expected = loadAllEntries(root, 'default')
      .filter(
        (e) =>
          e.source === 'session-digest' &&
          e.tags.includes('session-digest') &&
          !e.extracted_from &&
          !e.superseded_by &&
          e.source_session_id !== 's1',
      )
      .map((e) => e.content);
    expect([...expected].sort()).toEqual(['digest from another session', 'digest with no session']);
    expect(
      sqliteSyncStore(root).contextReads.liveContentsBySourceAndTag(
        'default',
        'session-digest',
        'session-digest',
        's1',
      ),
    ).toEqual(expected);
  });
});

describe('v56 migration', () => {
  it('a v55 store gains every new index on open and a second open is a no-op', () => {
    const root = newRoot();
    withDb(root, (db) => {
      for (const name of NEW_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`);
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '55')`).run();
    });
    const first = withDb(root, (db) => {
      // SAFETY: meta.value is TEXT; one row by primary key.
      expect((db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }).value).toBe(
        LATEST_SCHEMA_VERSION_STR,
      );
      return indexNames(db);
    });
    for (const name of NEW_INDEXES) expect(first).toContain(name);
    expect(withDb(root, indexNames)).toEqual(first);
  });
});
