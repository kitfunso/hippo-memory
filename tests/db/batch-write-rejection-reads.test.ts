// A sleep flush reads the live rows and tombstones of a window of writes at once, one tombstone read per tenant, so its
// reads stay flat as a batch grows; it still refuses each write that would bring a rejected text back, and audits it.
import { describe, expect, it } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { closeHippoDb, openHippoDb, SLEEP_DB_WAIT_MS } from '../../src/db/index.js';
import type { FlushComponent } from '../../src/store/port/consolidation.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { countMatching, recordStatements, recordStatementsAsync } from '../_helpers/count-statements.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { batchWriteAndDelete, commitInChunks, readEntry, writeEntriesTogether } from '../_helpers/root-forms.js';

oneRequestPerTest();

const TENANTS = ['tenant-a', 'tenant-b'] as const;
const LIVE_ROWS = /FROM memories WHERE id IN \(SELECT value FROM json_each\(\?\)\)$/;

const note = (tenantId: string, text: string): MemoryEntry => ({
  ...createMemory(`${tenantId} ${text}`, { layer: Layer.Semantic }),
  tenantId,
});

interface Batch {
  readonly home: string;
  readonly ops: MemoryEntry[];
  /** Per tenant: a live row whose own text was rejected after it was written, re-persisted unchanged. */
  readonly kept: MemoryEntry[];
  /** The live rows changed onto a rejected text, one a tenant, then the new rows of one. */
  readonly refused: MemoryEntry[];
}

// Each tenant: `perTenant` live rows re-persisted with one more retrieval, one of them changed onto a rejected text,
// one keeping its own rejected text, and a new row of a rejected text.
function tombstone(home: string, rows: readonly MemoryEntry[]): void {
  const db = openHippoDb(home);
  try {
    for (const row of rows) {
      insertRejectedValue(db, {
        tenantId: row.tenantId,
        digest: rejectionDigest(row.content),
        reason: 'test',
        rejectedBy: 'cli',
        rejectedAt: new Date().toISOString(),
        normalizedChars: normalizeValueForRejection(row.content).length,
      });
    }
  } finally {
    closeHippoDb(db);
  }
}

function auditedRefusals(home: string): Array<[string, string, unknown]> {
  const db = openHippoDb(home);
  try {
    const events = TENANTS.flatMap((tenantId) => queryAuditEvents(db, { tenantId, op: 'reject_refusal' }));
    return events.map((e): [string, string, unknown] => [e.targetId ?? '', e.actor, e.metadata.digest]).sort();
  } finally {
    closeHippoDb(db);
  }
}

const refusalsOf = (rows: readonly MemoryEntry[]): Array<[string, string, unknown]> =>
  rows.map((row): [string, string, unknown] => [row.id, 'sleep-batch', rejectionDigest(row.content)]).sort();

function batchOf(perTenant: number): Batch {
  const home = makeRoot('batch-rejection-reads');
  const live = TENANTS.map((t) =>
    Array.from({ length: perTenant }, (_, i) => note(t, `deploy note ${i} for the batch`)),
  );
  writeEntriesTogether(home, live.flat());
  const changed = live.map(([first], i) => ({ ...first!, content: `${TENANTS[i]} the changed text is rejected` }));
  const fresh = TENANTS.map((t) => note(t, 'the fresh text is rejected'));
  const kept = live.map((rows) => rows[1]!);
  tombstone(home, [...changed, ...fresh, ...kept]);
  const bumped = live
    .flatMap((rows, i) => [changed[i]!, ...rows.slice(1)])
    .map((row) => ({
      ...row,
      retrievalCount: row.retrievalCount + 1,
    }));
  return { home, ops: [...bumped, ...fresh], kept, refused: [...changed, ...fresh] };
}

describe('a sleep batch over rejected texts', () => {
  it.each([3, 30])('reads tombstones once per tenant for %i rows a tenant, and refuses only new text', (perTenant) => {
    const { home, ops, kept, refused } = batchOf(perTenant);
    const { statements } = recordStatements(() => batchWriteAndDelete(home, ops, []));
    expect(countMatching(statements, 'FROM rejected_values')).toBe(TENANTS.length);

    for (const row of kept) expect(readEntry(home, row.id, row.tenantId)?.retrievalCount).toBe(row.retrievalCount + 1);
    for (const row of refused.slice(0, 2)) {
      expect(readEntry(home, row.id, row.tenantId)?.content).toBe(`${row.tenantId} deploy note 0 for the batch`);
    }
    for (const row of refused.slice(2)) expect(readEntry(home, row.id, row.tenantId)).toBeNull();
    expect(auditedRefusals(home)).toEqual(refusalsOf(refused));
  });
});

const oneRow = (refresh: { id: string; strength: number } | MemoryEntry): FlushComponent => ({
  refreshes: 'content' in refresh ? [] : [refresh],
  writes: 'content' in refresh ? [refresh] : [],
  deletes: [],
  dormant: [],
});

describe("sleep's flush over one-row components", () => {
  // Windows of 16, 32, 64, 128 then 256 ops: 42 components take two, 402 take five.
  it.each([
    [40, 2],
    [400, 5],
  ])(
    'reads once a window over %i decay refreshes, in %i windows, and refuses the rejected writes',
    async (n, windows) => {
      const home = makeRoot('flush-window-reads');
      const live = Array.from({ length: n }, (_, i) => note(TENANTS[i % 2]!, `flush note ${i}`));
      writeEntriesTogether(home, live);
      const fresh = TENANTS.map((t) => note(t, 'the flushed text is rejected'));
      tombstone(home, fresh);
      const components = [...live.map((row) => oneRow({ id: row.id, strength: 0.5 })), ...fresh.map(oneRow)];
      const budget = { holdMs: Infinity, clock: () => 0, pause: async () => undefined };

      const { statements } = await recordStatementsAsync(() =>
        commitInChunks(home, components, { snapshot: new Map(), budget, busyWaitMs: SLEEP_DB_WAIT_MS }),
      );
      expect(countMatching(statements, LIVE_ROWS)).toBe(windows);
      expect(countMatching(statements, 'FROM rejected_values')).toBe(TENANTS.length * windows);
      for (const row of live) expect(readEntry(home, row.id, row.tenantId)?.strength).toBe(0.5);
      for (const row of fresh) expect(readEntry(home, row.id, row.tenantId)).toBeNull();
      expect(auditedRefusals(home)).toEqual(refusalsOf(fresh));
    },
  );
});
