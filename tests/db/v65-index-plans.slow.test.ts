// Schema v65's lookup indexes serve the reads they were added for, the vault page walk stays linear, and dropping
// idx_memories_current moves no plan. Each check runs the SQL the store really prepares.
import { describe, expect, it } from 'vitest';
import { closeHippoDb, openHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import type { EntryCursor } from '../../src/base/ports/store/types.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { listEntriesWhere } from '../../src/store/sqlite/entry-filter.js';
import { eventRecord } from '../../src/store/sqlite/connectors/events.js';
import { fillRejectionDigests } from '../../src/store/sqlite/text-digests.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAmbientCandidates } from '../_helpers/root-forms.js';

function plan(db: DatabaseSyncLike, sql: string): string {
  // SAFETY: EXPLAIN QUERY PLAN rows carry a TEXT `detail` column.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

function onDb<T>(root: string, fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

const at = (i: number): string => new Date(Date.UTC(2026, 0, 1) + ((i * 7919) % 10_000) * 1000).toISOString();

/** `vault` raw rows under one vault's prefix and `others` plain rows, in one transaction. */
function seedVault(root: string, vault: number, others = 3000): void {
  onDb(root, (db) => {
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < vault; i++) {
      const entry: MemoryEntry = {
        ...createMemory(`vault note ${i}`),
        kind: 'raw',
        artifactRef: `vault:notes:file${i}`,
      };
      upsertEntryRow(db, { ...entry, created: at(i) });
    }
    for (let i = 0; i < others; i++) upsertEntryRow(db, { ...createMemory(`other row ${i}`), created: at(i) });
    db.exec('COMMIT');
  });
}

/** Walks the vault import's page read to its end, counting each row the engine visits through a visit() term. */
function vaultWalk(root: string): { visits: number; rows: number; sql: string[] } {
  return onDb(root, (db) => {
    let visits = 0;
    db.function('visit', { deterministic: false }, () => ++visits);
    const sql: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = (text: string) => {
      if (!/artifact_ref >= \?/.test(text)) return prepare(text);
      sql.push(text);
      return prepare(text.replace('WHERE ', 'WHERE visit() AND '));
    };
    const filter = { tenantId: 'default', kinds: ['raw' as const], artifactRefPrefix: 'vault:notes:' };
    let rows = 0;
    let after: EntryCursor | undefined;
    do {
      const page = listEntriesWhere(db, filter, { limit: 500, after });
      rows += page.entries.length;
      after = page.next ?? undefined;
    } while (after !== undefined);
    return { visits, rows, sql };
  });
}

describe('schema v65 index plans', () => {
  it("seeks idx_memories_artifact_ref for a connector's raw rows", () => {
    const root = makeRoot('v65-plans');
    seedVault(root, 3, 3);
    onDb(root, (db) => {
      const { statements } = recordStatements(() =>
        eventRecord(
          db,
          { connector: 'slack', eventId: 'evt-1' },
          { artifactRef: 'vault:notes:file1', tenantId: 'default' },
        ),
      );
      const raw = statements.find((sql) => sql.includes('artifact_ref = ?'));
      expect(raw).toBeDefined();
      expect(plan(db, raw ?? '')).toContain('USING INDEX idx_memories_artifact_ref');
    });
  });

  it('walks vault pages in index order, so three times the vault costs under five times the visits', () => {
    const [small, large] = [makeRoot('v65-vault'), makeRoot('v65-vault')];
    seedVault(small, 1000);
    seedVault(large, 3000);
    const [one, three] = [vaultWalk(small), vaultWalk(large)];
    expect([one.rows, three.rows]).toEqual([1000, 3000]);
    onDb(large, (db) => {
      for (const sql of new Set(three.sql)) {
        expect(plan(db, sql)).toContain('USING INDEX idx_memories_artifact_created');
        expect(plan(db, sql)).not.toContain('USE TEMP B-TREE');
      }
    });
    expect(three.visits).toBeLessThan(5 * one.visits);
  });

  it('prunes session owners and fills digests by their indexes', async () => {
    const root = makeRoot('v65-plans');
    seedVault(root, 2, 2);
    const bind = await recordStatementsAsync(() =>
      sqliteStore(root).sessions.bindSessionOwner('default', 'session-1', 'alice', 60_000),
    );
    const prune = bind.statements.find((sql) => sql.startsWith('DELETE FROM session_owners'));
    onDb(root, (db) => {
      expect(plan(db, prune ?? '')).toContain('USING INDEX idx_session_owners_created_at');
      db.exec('UPDATE memories SET rejection_digest = NULL');
      const fill = recordStatements(() => fillRejectionDigests(db));
      const reads = fill.statements.filter((sql) => /WHERE rejection_digest IS NULL/.test(sql));
      expect(reads.length).toBeGreaterThan(0);
      for (const sql of reads) {
        expect(plan(db, sql)).toMatch(/USING (COVERING )?INDEX idx_(dormant_)?memories_rejection_digest/);
      }
    });
  });

  it('gives the ambient reads the same plan with or without the idx_memories_current v65 drops', () => {
    const root = makeRoot('v65-plans');
    seedVault(root, 2, 20);
    const { statements } = recordStatements(() => loadAmbientCandidates(root, 'default', 1, () => true));
    const current = statements.filter((sql) => sql.includes('superseded_by IS NULL'));
    expect(current.length).toBeGreaterThan(0);
    onDb(root, (db) => {
      const before = current.map((sql) => plan(db, sql));
      db.exec('CREATE INDEX idx_memories_current ON memories(layer, created) WHERE superseded_by IS NULL');
      expect(current.map((sql) => plan(db, sql))).toEqual(before);
    });
  });
});
