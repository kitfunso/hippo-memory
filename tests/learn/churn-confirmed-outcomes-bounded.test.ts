// The churn pass reads good-outcome times from a ts range, not the tenant's whole audit history, and says so in its plan.
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { detectChurnStale } from '../../src/domain/learn/invalidation.js';
import { sqliteStore, sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { processGit } from '../../src/base/util/git-runner.js';

const OLD_TARGETS = 200;
/** Rows the confirmed-outcome statement handed to JavaScript in `reads`. */
const outcomeRows = (reads: readonly { sql: string; rows: number }[]): number =>
  reads
    .filter((r) => r.sql.includes('FROM audit_log') && r.sql.includes('GROUP BY target_id'))
    .reduce((n, r) => n + r.rows, 0);
const roots: string[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function newRoot(): string {
  const root = makeRoot('churn-outcomes');
  roots.push(root);
  return root;
}

type Outcome = readonly [targetId: string, ts: string, good: boolean];

function addOutcomes(root: string, outcomes: readonly Outcome[]): void {
  const db = openHippoDb(root);
  try {
    const insert = db.prepare(
      `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, 'default', 'test', 'outcome', ?, ?)`,
    );
    db.exec('BEGIN');
    for (const [targetId, ts, good] of outcomes) insert.run(ts, targetId, JSON.stringify({ good }));
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}

function seedHistory(root: string): void {
  const old = Array.from({ length: OLD_TARGETS }, (_, i): Outcome => [`old-${i}`, '2020-01-01T00:00:00.000Z', true]);
  addOutcomes(root, [
    ...old,
    ['new-a', '2026-03-01T00:00:00.000Z', true],
    ['new-a', '2026-04-01T00:00:00.000Z', true],
    ['new-b', '2026-05-01T00:00:00.000Z', true],
    ['new-bad', '2026-05-01T00:00:00.000Z', false],
  ]);
}

describe('confirmedOutcomeTimes', () => {
  it('returns the latest good outcome per target since the bound and reads no older row', () => {
    const root = newRoot();
    seedHistory(root);
    const learning = sqliteSyncStore(root).learning;

    const { result, reads } = recordStatements(() =>
      learning.confirmedOutcomeTimes('default', '2026-01-01T00:00:00.000Z'),
    );

    expect([...result.entries()].sort()).toEqual([
      ['new-a', '2026-04-01T00:00:00.000Z'],
      ['new-b', '2026-05-01T00:00:00.000Z'],
    ]);
    expect(outcomeRows(reads)).toBe(2);
    expect(learning.confirmedOutcomeTimes('default', '2019-01-01T00:00:00.000Z').size).toBe(OLD_TARGETS + 2);
  });

  it('plans the read as a range on the (tenant_id, ts) index, so rows before the bound are never visited', () => {
    const root = newRoot();
    seedHistory(root);
    const { statements } = recordStatements(() =>
      sqliteSyncStore(root).learning.confirmedOutcomeTimes('default', '2026-01-01T00:00:00.000Z'),
    );
    const sql = statements.find((s) => s.includes('FROM audit_log') && s.includes('GROUP BY target_id'));
    expect(sql).toBeDefined();

    const db = openHippoDb(root);
    try {
      // SAFETY: an EXPLAIN QUERY PLAN row carries a text `detail` column.
      const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('default', '2026-01-01T00:00:00.000Z') as Array<{
        detail: string;
      }>;
      expect(rows.map((row) => row.detail).join('\n')).toMatch(
        /SEARCH audit_log USING INDEX idx_audit_log_tenant_ts \(tenant_id=\? AND ts>\?\)/,
      );
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('detectChurnStale', () => {
  it('starts its outcome read at the oldest candidate, so older outcomes never reach it', async () => {
    const root = newRoot();
    seedHistory(root);
    const entry = { ...createMemory('a plain note about the team', { tenantId: 'default' }), originProject: 'proj' };
    writeEntry(root, entry);

    const { result, reads } = await recordStatementsAsync(() =>
      detectChurnStale(
        sqliteStore(root),
        { root: '/no/such/repo', git: processGit },
        {
          tenantId: 'default',
          projectName: 'proj',
        },
      ),
    );

    expect(result.checked).toBe(1);
    // The candidate was written now, after every seeded outcome, so no outcome row is read for it.
    expect(outcomeRows(reads)).toBe(0);
  });
});
