// AuditMaintenance answers alike on hippo.db and on a store held in memory: the object-backed read, the guarded
// automatic deletes, the audit prune, and quality repair's plan, apply and once-per-store run.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { PROTECTED_ROWS } from '../../src/base/memory/memory-audit.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import type { QualityRepairResult } from '../../src/store/port/audit-maintenance.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type SideResult,
  valueAt,
  type TwoTenantFixture,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const START = Date.parse('2026-03-01T12:00:00.000Z');
const CUT = 'Found local migration files to be';
const DOUBTFUL = 'When CI fails we retry once';
const NO_PROTECTION = { pinned: false, raw: false, trusted: false, objectBacked: false };

let fixture: TwoTenantFixture;
const rows: Record<string, MemoryEntry> = {};

function seedRow(name: string, content: string, over: Partial<MemoryEntry> = {}): void {
  const captured = createMemory(content, { source: 'capture', confidence: 'observed', layer: Layer.Episodic });
  const row = { ...captured, tenantId: TENANT_A, originProject: 'proj', ...over };
  writeEntry(fixture.dir, row, { actor: 'cli' });
  rows[name] = row;
}

function seed(): void {
  seedRow('cut', CUT);
  seedRow('pinnedCut', CUT, { pinned: true });
  seedRow('doubt', DOUBTFUL);
  seedRow('person', CUT, { source: 'cli' });
  seedRow('plain', 'the nightly build runs at two', { source: 'cli' });
  seedRow('plainToo', 'the release train leaves on friday', { source: 'cli' });
  seedRow('raw', 'raw line: the build is red', { kind: 'raw', source: 'cli' });
  seedRow('cutB', CUT, { tenantId: TENANT_B });
  const mirror = { ...createMemory('we chose sqlite for the queue', { tenantId: TENANT_A }), originProject: 'proj' };
  const fields = { decisionText: 'use sqlite', context: undefined };
  sqliteSyncStore(handlesOf(fixture.dir)).objects.saveObject(TENANT_A, 'decision', {
    mirror,
    fields,
    actor: 'cli',
    at: '2026-02-01T00:00:00.000Z',
  });
  rows.backed = mirror;
}

beforeAll(() => {
  fixture = seedTwoTenants();
  seed();
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

// A repair's folder, schema version and backup file are hippo.db's files; a store with none answers '', 0 and null.
const planOf = (result: QualityRepairResult | null) =>
  result && { ...result, root: 'folder', schema: 'version', backup: 'kept by the store' };

function withoutBackupFile(side: SideResult<unknown>): SideResult<unknown> {
  const audit = side.audit.map((row) =>
    row.op === 'quality_repair' ? { ...row, metadata: { ...row.metadata, backup: 'kept by the store' } } : row,
  );
  return { ...side, audit };
}

/** Each call one second after the one before. */
async function conforms(calls: readonly GroupCall<'auditMaintenance', unknown>[]) {
  const timed = calls.map((call, i): GroupCall<'auditMaintenance', unknown> => (methods, store) => {
    vi.setSystemTime(START + i * 1000);
    return call(methods, store);
  });
  const sides = await onBothStores(fixture, 'auditMaintenance', timed);
  expectSameOutcomes({ other: withoutBackupFile(sides.other), sqlite: withoutBackupFile(sides.sqlite) });
  return sides;
}

const id = (name: string): string => rows[name]!.id;

describe('AuditMaintenance', () => {
  it('reads object-backed ids, deletes only what the guard lets go, and prunes one tenant before a cutoff', async () => {
    const { sqlite } = await conforms([
      (g) => g.objectBackedAmong([id('backed'), id('plain'), 'mem_none']).then((found) => [...found]),
      (g) =>
        g.deleteAutomatically(
          ['plain', 'pinnedCut', 'raw', 'backed', 'plainToo'].map((name) => ({ id: id(name), reason: `${name} went` })),
          'sleep',
        ),
      (g) => g.deleteAutomatically([{ id: 'mem_none', reason: '' }], 'sleep'),
      (g) => g.deleteAutomatically([], 'sleep'),
      (g) =>
        g.pruneAuditRows({
          tenantId: TENANT_A,
          cutoff: new Date(START + 1500).toISOString(),
          actor: 'cli',
          olderThanDays: 30,
          dryRun: true,
        }),
      (g) =>
        g.pruneAuditRows({
          tenantId: TENANT_A,
          cutoff: new Date(START + 1500).toISOString(),
          actor: 'cli',
          olderThanDays: 30,
          dryRun: false,
        }),
      (g) =>
        g.pruneAuditRows({
          tenantId: TENANT_B,
          cutoff: '2100-01-01T00:00:00.000Z',
          actor: 'cli',
          olderThanDays: 1,
          dryRun: false,
        }),
      (_g, s) =>
        s
          .entriesByIds(
            Object.values(rows).map((r) => r.id),
            TENANT_A,
          )
          .then((found) => found.map((e) => e.content)),
    ]);
    expect(sqlite.outcomes.slice(0, 4)).toEqual([
      { value: [id('backed')] },
      { value: [id('plain'), id('plainToo')] },
      { value: [] },
      { value: [] },
    ]);
    expect(sqlite.outcomes[4]).toEqual({ value: 2 });
    expect(sqlite.audit.filter((row) => row.tenantId === TENANT_B).map((row) => row.op)).toEqual(['audit_prune']);
  });

  it('plans repairs per tenant under each protection, applies the certain ones to dormant, and runs once per store', async () => {
    const { sqlite } = await conforms([
      (g) => g.repairQuality(TENANT_A, false, PROTECTED_ROWS).then(planOf),
      (g) => g.repairQuality(TENANT_A, false, NO_PROTECTION).then(planOf),
      (g) => g.repairQuality(TENANT_B, false, PROTECTED_ROWS).then(planOf),
      (g) => g.repairQuality(TENANT_A, true, PROTECTED_ROWS).then(planOf),
      (_g, s) => s.dormant.list(TENANT_A, null, {}),
      (g) => g.repairQualityOnce(TENANT_B, PROTECTED_ROWS).then(planOf),
      (g) => g.repairQualityOnce(TENANT_A, PROTECTED_ROWS).then(planOf),
      (_g, s) =>
        s
          .entriesByIds(
            Object.values(rows).map((r) => r.id),
            TENANT_A,
          )
          .then((found) => found.map((e) => e.content)),
    ]);
    const plan = (i: number) => valueAt<QualityRepairResult>(sqlite.outcomes, i);
    expect(plan(0).issues.map((issue) => [issue.id, issue.disposition])).toEqual([
      [id('cut'), 'set-aside'],
      [id('pinnedCut'), 'protected'],
      [id('doubt'), 'review'],
    ]);
    expect(plan(1).issues.map((issue) => issue.disposition)).toEqual(['set-aside', 'set-aside', 'review']);
    expect(plan(3).appliedIds).toEqual([id('cut')]);
    expect(plan(5).appliedIds).toEqual([id('cutB')]);
    expect(sqlite.outcomes[6]).toEqual({ value: null });
  });
});
