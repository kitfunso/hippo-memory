// Reads and writes that once spent more statements or a wider scan now answer the same rows. Real store.
import { describe, expect, it } from 'vitest';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { listAuditEvents } from '../../src/store/sqlite/audit.js';
import { listEntriesWhere, prefixUpperBound } from '../../src/store/sqlite/entry-filter.js';
import { finishRecall } from '../../src/store/sqlite/last-recall.js';
import type { RecallWrites } from '../../src/base/ports/store/recall-writes.js';
import { rowsInPages } from '../../src/base/util/pages.js';
import type { EntryCursor } from '../../src/base/ports/store/types.js';
import { countMatching, recordStatements } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { seedRows } from '../_helpers/seed-rows.js';
import { evalNow } from '../../src/infra/eval-switches.js';

const SOURCES = [
  'agent-memory:claude-code:p-a/one.md',
  'AGENT-MEMORY:claude-code:p-a/two.md',
  'agent-memory:claude-code:p-b/three.md',
  'agent_memory:claude-code:p-a/four.md',
  'agent-memory:claude-code:p-a/five.md',
  'cli',
  'agent-memory:claude-code:p-a%/six.md',
];

describe('the live rows under a source prefix', () => {
  const prefixes = ['agent-memory:claude-code:p-a/', 'agent-memory:', 'AGENT-', 'agent-memory:claude-code:p-a%', ''];

  it('match case-sensitively and literally, in store order, whatever the page size', () => {
    const root = makeRoot('source-prefix-rows');
    const rows = seedRows(
      root,
      SOURCES.length,
      (i) => `row ${i}`,
      (i) => ({
        source: SOURCES[i]!,
        created: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      }),
    );
    const tenant = rows[0]!.tenantId;
    const db = openHippoDb(root);
    try {
      for (const prefix of prefixes) {
        const want = rows.filter((r) => r.source.startsWith(prefix)).map((r) => r.id);
        for (const limit of [1, 2, 100]) {
          const got = [
            ...rowsInPages((after?: EntryCursor) =>
              listEntriesWhere(db, { tenantId: tenant, sourcePrefix: prefix, live: true }, { limit, after }),
            ),
          ];
          expect(got.map((e) => e.id)).toEqual(want);
        }
      }
    } finally {
      closeHippoDb(db);
    }
  });

  it('read through the source index, with no table scan', () => {
    const root = makeRoot('source-prefix-plan');
    seedRows(
      root,
      3,
      (i) => `row ${i}`,
      (i) => ({ source: SOURCES[i]! }),
    );
    const db = openHippoDb(root);
    try {
      const log = recordStatements(() =>
        listEntriesWhere(db, { tenantId: 'default', sourcePrefix: 'agent-memory:', live: true }, { limit: 5 }),
      );
      const sql = log.statements.find((s) => s.includes('source >= ?'));
      if (sql === undefined) throw new Error('no range statement ran');
      expect(countMatching(log.statements, 'FROM memories')).toBe(1);
      // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('agent-memory:', 'agent-memory;', 'default', 5) as Array<{
          detail: string;
        }>
      )
        .map((r) => r.detail)
        .join(' | ');
      expect(plan).toMatch(
        /SEARCH memories USING (COVERING )?INDEX idx_memories_source_tenant_created \(source>\? AND source<\?/,
      );
      expect(plan).not.toMatch(/SCAN memories/);
    } finally {
      closeHippoDb(db);
    }
  });

  it('end where the next prefix begins', () => {
    expect(prefixUpperBound('abc')).toBe('abd');
    expect(prefixUpperBound('')).toBeNull();
    expect(prefixUpperBound('a\u{10FFFF}')).toBe('b');
    expect(prefixUpperBound('\u{10FFFF}')).toBeNull();
    expect(prefixUpperBound('a\uD7FF')).toBe('a\uE000');
    expect(prefixUpperBound('a😀')).toBe('a\u{1F601}');
  });
});

describe('finishRecall audit rows', () => {
  it('go in one statement, in the order they happened', () => {
    const root = makeRoot('finish-recall-audit');
    const db = openHippoDb(root);
    try {
      const audit = (['recall', 'recall_anchor_skipped_no_session', 'recall'] as const).map((op, i) => ({
        tenantId: 'default',
        actor: 'cli',
        op,
        targetId: `t${i}`,
      }));
      const writes: RecallWrites = { goalLog: [], audit };
      const log = recordStatements(() => finishRecall(db, { strength: PRODUCTION_STRENGTH, clock: evalNow }, writes));
      expect(countMatching(log.statements, 'INSERT INTO audit_log')).toBe(1);
      const rows = listAuditEvents(db, { tenantId: 'default', limit: 10 });
      expect(rows.map((r) => r.targetId)).toEqual(['t2', 't1', 't0']);
    } finally {
      closeHippoDb(db);
    }
  });
});
