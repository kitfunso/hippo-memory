// Store passes that walk many rows open the store once and read rows in chunked IN lists, so query counts stay flat as rows grow.
// Row reads by id and the read surfaces: outcome, quarantine, drill-down, strengthening, the dashboard and hippo_status.
import { describe, it, expect } from 'vitest';
import { recordStatements, recordStatementsAsync, countMatching, STORE_OPEN } from '../_helpers/count-statements.js';
import { closeHippoDb } from '../../src/db/index.js';
import { Layer } from '../../src/core/memory.js';
import { outcome } from '../../src/api/memories/outcome.js';
import { quarantineList } from '../../src/api/auth/quarantine.js';
import { drillDown } from '../../src/api/objects/drill-down.js';
import { quarantineScopeFor } from '../../src/trust/quarantine.js';
import { recordQuarantine } from '../../src/store/sqlite/quarantine.js';
import { buildMemoryDetail } from '../../src/api/dashboard/queries.js';
import { snapshotsOf } from '../_helpers/dashboard-fixture.js';
import { handleMcpRequest } from '../../src/mcp/server.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadEntriesByIds, replaceDetectedConflicts, strengthenRetrieved, readEntry } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/core/config.js';
import { openStore } from '../../src/store/sqlite/handles.js';
import {
  ROW_READ,
  SIZES,
  ctxFor,
  freshRoot,
  memory,
  rows,
  seed,
  useQueryCountRoots,
} from '../_helpers/query-count-seeds.js';

useQueryCountRoots();

describe('outcome', () => {
  it('opens the store once and reads every id in one query', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-outcome');
      const entries = rows(n, 'outcome');
      seed(ctxFor(root), entries);
      const { result, statements } = await recordStatementsAsync(() =>
        outcome(
          ctxFor(root),
          entries.map((e) => e.id),
          true,
        ),
      );
      expect(result.applied).toBe(n);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });
});

describe('quarantineList', () => {
  it('reads every listed memory in one query', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-quarantine');
      const entries = rows(n, 'held', { scope: quarantineScopeFor(null) });
      seed(ctxFor(root), entries, (db, e) =>
        recordQuarantine(db, {
          tenantId: 'default',
          memoryId: e.id,
          originalScope: null,
          reason: 'test',
          actor: 'test',
        }),
      );
      const { result, statements } = await recordStatementsAsync(() => quarantineList(ctxFor(root), { limit: 500 }));
      expect(result).toHaveLength(n);
      expect(result.every((item) => item.contentPreview.includes('zephyrine'))).toBe(true);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });
});

describe('drillDown', () => {
  it('reads one query per DAG level, not one per parent', async () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-drill');
      const summary = memory('summary of the zephyrine cache work', { dagLevel: 2, layer: Layer.Semantic });
      const mids = rows(n, 'mid', { dagLevel: 1, dagParentId: summary.id });
      const leaves = mids.map((m, i) =>
        memory(`leaf ${i} under the zephyrine cache`, { dagLevel: 0, dagParentId: m.id }),
      );
      seed(ctxFor(root), [summary, ...mids, ...leaves]);
      const { result, statements } = await recordStatementsAsync(() =>
        drillDown(ctxFor(root), summary.id, { depth: 2, limit: 1000 }),
      );
      expect('failure' in result ? result.failure : result.totalChildren).toBe(2 * n);
      expect(countMatching(statements, STORE_OPEN)).toBe(1);
      expect(countMatching(statements, ROW_READ)).toBe(3);
    }
  });

  it('reads whole rows for the page only, however many children the summary has', async () => {
    const read: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-drill-page');
      const summary = memory('summary of the zephyrine cache work', { dagLevel: 2, layer: Layer.Semantic });
      // Newest first on disk, so the page is the oldest five only if the read sorts by created.
      const children = Array.from({ length: n }, (_, i) =>
        memory(`child ${i} of the zephyrine cache`, {
          dagLevel: 1,
          dagParentId: summary.id,
          created: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString(),
        }),
      );
      seed(ctxFor(root), [summary, ...children]);
      const { result, rowsRead } = await recordStatementsAsync(() => drillDown(ctxFor(root), summary.id, { limit: 5 }));
      if ('failure' in result) throw new Error(result.failure);
      expect(result.children.map((c) => c.id)).toEqual(
        children
          .slice(-5)
          .reverse()
          .map((c) => c.id),
      );
      expect({ total: result.totalChildren, truncated: result.truncated }).toEqual({ total: n, truncated: true });
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });

  it('finds children through the parent index, with a page and without one', async () => {
    const root = freshRoot('qc-drill-plan');
    const summary = memory('summary of the zephyrine cache work', { dagLevel: 2, layer: Layer.Semantic });
    const mids = rows(3, 'mid', { dagLevel: 1, dagParentId: summary.id });
    seed(ctxFor(root), [
      summary,
      ...mids,
      ...mids.map((m, i) => memory(`leaf ${i}`, { dagLevel: 0, dagParentId: m.id })),
    ]);
    const { statements } = await recordStatementsAsync(async () => {
      await drillDown(ctxFor(root), summary.id, { depth: 2, limit: 4 });
      await drillDown(ctxFor(root), summary.id, { depth: 2, limit: Number.POSITIVE_INFINITY });
    });
    const childReads = [...new Set(statements.filter((sql) => sql.includes('WHERE dag_parent_id IN (')))];
    expect(childReads.length).toBeGreaterThanOrEqual(5);
    const db = openStore(root);
    try {
      for (const sql of childReads) {
        // SAFETY: EXPLAIN QUERY PLAN answers one row per step, its text in `detail`.
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
          (step) => step.detail,
        );
        expect(plan[0], sql).toBe('SEARCH memories USING INDEX idx_memories_dag_parent (dag_parent_id=?)');
      }
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('strengthenRetrieved', () => {
  it('reads every id in one query', () => {
    for (const n of SIZES) {
      const root = freshRoot('qc-strengthen');
      const entries = rows(n, 'strengthen');
      seed(ctxFor(root), entries);
      const { result, statements } = recordStatements(() =>
        strengthenRetrieved(
          root,
          entries.map((e) => e.id),
          { tenantId: 'default', recallBoostAblated: false },
          {},
        ),
      );
      expect(result.size).toBe(n);
      expect(countMatching(statements, ROW_READ)).toBe(1);
    }
  });

  it('moves a repeated id once, as one read per id did', () => {
    const root = freshRoot('qc-strengthen-repeat');
    const [entry] = rows(1, 'repeat');
    seed(ctxFor(root), [entry]);
    expect([
      ...strengthenRetrieved(root, [entry.id, entry.id], { tenantId: 'default', recallBoostAblated: false }, {}),
    ]).toEqual([entry.id]);
    const after = readEntry(root, entry.id);
    expect(after?.retrievalCount).toBe(entry.retrievalCount + 1);
    expect(after?.halfLifeDays).toBe(entry.halfLifeDays + 2);
  });
});

describe('outcome with a repeated id', () => {
  it('applies the outcome twice, as one read per id did', async () => {
    const root = freshRoot('qc-outcome-repeat');
    const [entry] = rows(1, 'repeat');
    seed(ctxFor(root), [entry]);
    expect((await outcome(ctxFor(root), [entry.id, entry.id], false)).applied).toBe(2);
    expect(readEntry(root, entry.id)?.outcomeNegative).toBe(2);
  });
});

describe('buildMemoryDetail', () => {
  it('reads the conflicts naming a memory and their other sides in a fixed number of queries', async () => {
    const work: number[][] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-detail');
      const [subject, ...others] = rows(n + 1, 'detail');
      seed(ctxFor(root), [subject, ...others]);
      replaceDetectedConflicts(root, [
        ...others.map((e) => ({ memory_a_id: subject.id, memory_b_id: e.id, reason: 'names the subject', score: 0.9 })),
        { memory_a_id: others[0].id, memory_b_id: others[1].id, reason: 'between two others', score: 0.8 },
      ]);
      const options = { snapshotId: 1, nowMs: Date.now(), embedded: false, lossAversion: {} };
      const store = sqliteStore(root);
      const { result, statements } = await recordStatementsAsync(() =>
        buildMemoryDetail(store, 'default', subject, options),
      );
      expect(result.conflicts.map((c) => c.other.id).sort()).toEqual(others.map((e) => e.id).sort());
      expect(result.conflicts.every((c) => c.reason === 'names the subject')).toBe(true);
      work.push([countMatching(statements, STORE_OPEN), countMatching(statements, ROW_READ)]);
    }
    expect(work[1]).toEqual(work[0]);
  });
});

describe('the dashboard snapshot build', () => {
  it('reads no whole row, and no row at all for a memory it leaves out', () => {
    const read: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-dash-build');
      seed(ctxFor(root), [
        ...rows(4, 'live'),
        ...rows(n, 'archived', { kind: 'archived' }),
        ...rows(n, 'replaced', { kind: 'superseded' }),
      ]);
      const service = snapshotsOf(root, () => Date.now());
      try {
        const { result, statements, rowsRead } = recordStatements(() => service.get('default'));
        expect(result.facts).toHaveLength(4);
        expect(result.excluded).toEqual({ superseded: n, archived: n, quarantined: 0 });
        expect(countMatching(statements, ROW_READ)).toBe(0);
        read.push(rowsRead);
      } finally {
        service.close();
      }
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('hippo_status', () => {
  it("tallies in SQL, so rows read stay flat, and counts only its tenant's open conflicts", async () => {
    const read: number[] = [];
    for (const n of SIZES) {
      const root = freshRoot('qc-status');
      const own = [
        ...rows(n - 3, 'status'),
        memory('status row long faded', { lastRetrieved: '2020-01-01T00:00:00.000Z', halfLifeDays: 1 }),
        memory('status row pinned', { pinned: true, tags: ['errors-seen'] }),
        memory('status row tagged as an error', { tags: ['deploy', 'error'] }),
      ];
      const elsewhere = rows(2, 'elsewhere', { tenantId: 'other' });
      seed(ctxFor(root), [...own, ...elsewhere]);
      replaceDetectedConflicts(root, [
        { memory_a_id: own[0].id, memory_b_id: own[1].id, reason: 'own pair', score: 0.9 },
        { memory_a_id: elsewhere[0].id, memory_b_id: elsewhere[1].id, reason: 'other tenant pair', score: 0.9 },
      ]);
      const { result, rowsRead } = await recordStatementsAsync(() =>
        handleMcpRequest(
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_status', arguments: {} } },
          {
            hippoRoot: root,
            tenantId: 'default',
            actor: 'tester',
            role: 'admin',
            hostAdmin: true,
            clientKey: 'client-1',
            store: sqliteStore(root),
            config: loadConfig(root),
          },
        ),
      );
      const reply = JSON.stringify(result);
      expect(reply).toContain(`Memories: ${n} (1 pinned, 1 errors)`);
      expect(reply).toContain('At risk (<0.2): 1\\n');
      expect(reply).toContain('Open conflicts: 1\\n');
      read.push(rowsRead);
    }
    expect(read[1]).toBe(read[0]);
  });
});

describe('an id-list read of one tenant', () => {
  it('seeks each id on the primary key, never walking every row of the tenant', async () => {
    const root = freshRoot('qc-id-plan');
    const entries = rows(10, 'plan');
    seed(ctxFor(root), entries);
    const ids = entries.map((e) => e.id);
    const { result, statements } = await recordStatementsAsync(async () => {
      await outcome(ctxFor(root), ids, true);
      return {
        held: (await sqliteStore(root).entriesByIds(ids, 'default')).some((e) => e.id === ids[0]),
        listed: loadEntriesByIds(root, ids, 'default').length,
      };
    });
    expect(result).toEqual({ held: true, listed: 10 });

    const idReads = [...new Set(statements.filter((sql) => sql.includes('FROM memories WHERE id IN (')))];
    expect(idReads).toHaveLength(2);
    const db = openStore(root);
    try {
      for (const sql of idReads) {
        // SAFETY: EXPLAIN QUERY PLAN answers one row per step, its text in `detail`.
        const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map(
          (step) => step.detail,
        );
        expect(plan[0], sql).toBe('SEARCH memories USING INDEX sqlite_autoindex_memories_1 (id=?)');
      }
    } finally {
      closeHippoDb(db);
    }
  });
});
