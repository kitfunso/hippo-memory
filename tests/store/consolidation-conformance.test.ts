// Consolidation answers: a sleep's opening, its reads, the settle of a
// dirty summary, the flush and dormant expiry, and the run record.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { DAG_LEVEL, Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import type { PhysicsParticle } from '../../src/base/rank/physics.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { savePhysicsState } from '../../src/db/physics-state.js';
import type { HippoStore, StoreGroups } from '../../src/base/ports/store-index.js';
import type { SleepCommit, SummarySettle } from '../../src/base/ports/store/consolidation.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  runOnFixture,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
  valueAt,
} from '../_helpers/store-conformance.js';
import { appendSessionEvent, writeEntry } from '../_helpers/root-forms.js';

const START = Date.parse('2026-03-01T12:00:00.000Z');
const AT = '2026-02-15T00:00:00.000Z';
const REFUSED = 'the summary nobody wants';
const TOPIC = { layer: Layer.Semantic, dagLevel: DAG_LEVEL.topic, tags: ['dag-summary', 'topic:billing'] };

let fixture: TwoTenantFixture;
const rows: Record<string, MemoryEntry> = {};

function seedRow(name: string, content: string, over: Parameters<typeof createMemory>[1] = {}): MemoryEntry {
  const row = { ...createMemory(content, { tenantId: TENANT_A, ...over }), originProject: 'proj' };
  writeEntry(fixture.dir, row, { actor: 'cli' });
  rows[name] = row;
  return row;
}

function seedSummaries(): void {
  const topic = seedRow('topic', 'alice runs billing and payroll', TOPIC);
  seedRow('fact1', 'alice runs billing', { dagLevel: DAG_LEVEL.extracted, dagParentId: topic.id, tags: ['extracted'] });
  seedRow('fact2', 'alice runs payroll', { dagLevel: DAG_LEVEL.extracted, dagParentId: topic.id, tags: ['extracted'] });
  const refusing = seedRow('refusing', 'bob owns the release train', TOPIC);
  seedRow('fact3', 'bob owns releases', {
    dagLevel: DAG_LEVEL.extracted,
    dagParentId: refusing.id,
    tags: ['extracted'],
  });
  seedRow('fresh', 'carol answers pages', TOPIC);
  seedRow('topicB', 'globex runs its own billing', { ...TOPIC, tenantId: TENANT_B });
}

function particle(memoryId: string, x: number): PhysicsParticle {
  return {
    memoryId,
    position: [x, 0, 0, 0],
    velocity: [0, 0, 0, 0],
    mass: 1,
    charge: 0,
    temperature: 1,
    lastSimulation: AT,
  };
}

function seedTables(): void {
  const db = openHippoDb(fixture.dir);
  try {
    const ids = ['topic', 'refusing', 'fresh'].map((name) => rows[name]!.id);
    db.prepare('UPDATE memories SET summary_dirty = 1 WHERE id IN (SELECT value FROM json_each(?))').run(
      JSON.stringify(ids),
    );
    insertRejectedValue(db, {
      tenantId: TENANT_A,
      digest: rejectionDigest(REFUSED),
      reason: 'wrong',
      rejectedBy: 'cli',
      rejectedAt: AT,
      normalizedChars: normalizeValueForRejection(REFUSED).length,
    });
    const dormant = (content: string, dormantAt: string): void => {
      const entry = { ...createMemory(content, { tenantId: TENANT_A }), originProject: 'proj' };
      insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt });
    };
    dormant('the old staging host was build-01', '2001-01-01T00:00:00.000Z');
    dormant('the staging host was build-07', AT);
    savePhysicsState(db, [particle(rows.kept!.id, 0.5), particle(rows.edited!.id, 0.25)]);
  } finally {
    closeHippoDb(db);
  }
}

async function seed(): Promise<void> {
  seedSummaries();
  seedRow('twin1', 'the release train leaves at noon on thursday');
  seedRow('twin2', 'the release  train leaves at noon on thursday');
  seedRow('trace', 'deploy trace: ran the canary', { layer: Layer.Trace, sourceSessionId: 'traced' });
  seedRow('kept', 'the nightly build runs at two');
  seedRow('edited', 'the deploy window is friday');
  seedRow('gone', 'the old wiki lives on confluence');
  seedRow('pinned', 'never deploy on a friday afternoon', { pinned: true });
  seedRow('fading', 'the canary host was canary-3');
  for (const [tenantId, sessionId] of [
    [TENANT_A, 'done'],
    [TENANT_A, 'traced'],
    [TENANT_B, 'elsewhere'],
  ] as const) {
    await appendSessionEvent(fixture.dir, tenantId, { sessionId, eventType: 'session_complete', content: 'success' });
  }
  seedTables();
}

beforeAll(async () => {
  fixture = seedTwoTenants();
  await seed();
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

/** Each call one second after the one before. */
async function conforms(calls: readonly GroupCall<'consolidation', unknown>[]) {
  const timed = calls.map((call, i): GroupCall<'consolidation', unknown> => (methods, store) => {
    vi.setSystemTime(START + i * 1000);
    return call(methods, store);
  });
  return runOnFixture(fixture, 'consolidation', timed);
}

const id = (name: string): string => rows[name]!.id;
const named = (...names: string[]): string[] => names.map(id);
const read = (names: string[]) => (_g: StoreGroups['consolidation'], s: HippoStore) =>
  s.entriesByIds(named(...names), TENANT_A);

function rebuilt(name: string, text: string): SummarySettle {
  const audit = { dag_level: DAG_LEVEL.topic, source: 'E3-rebuild', zero_children: false, descendant_count: 2 };
  return {
    id: id(name),
    tenantId: TENANT_A,
    actor: 'sleep',
    fields: { content: { text, rebuiltAt: AT }, descendantCount: 2, earliestAt: AT, latestAt: AT },
    audit: [{ tenantId: TENANT_A, actor: 'sleep', op: 'summary_rebuilt', targetId: id(name), metadata: audit }],
  };
}

// An untraced session comes with its events, the ones its complete event ends.
const untraced = (sessionId: string) => ({
  sessionId,
  events: expect.arrayContaining([expect.objectContaining({ eventType: 'session_complete' })]),
});

describe('Consolidation', () => {
  it('opens a sleep: moves the half-lives once, and reads the history and the untraced sessions', async () => {
    const traces = (tenantId: string) => ({ tenantId, sinceMs: 0 });
    const sqlite = await conforms([
      (g) => g.begin(30, { dryRun: true, actor: 'test', traces: traces(TENANT_A) }),
      (g) => g.begin(30, { dryRun: false, actor: 'test' }),
      (g) => g.begin(30, { dryRun: true, actor: 'test', traces: traces(TENANT_B) }),
      read(['kept', 'pinned', 'trace']),
    ]);
    expect(valueAt(sqlite.outcomes, 0)).toMatchObject({
      from: DEFAULT_HALF_LIFE_DAYS,
      fts: null,
      sessions: [untraced('done')],
    });
    expect(valueAt(sqlite.outcomes, 2)).toMatchObject({ from: 30, outcome: null, sessions: [untraced('elsewhere')] });
    expect(sqlite.audit.filter((row) => row.op === 'half_life_migrate').length).toBeGreaterThan(0);
  });

  it('reads ids, tombstones, particles, duplicates and topic summaries, and writes particles and audit rows', async () => {
    const sqlite = await conforms([
      (g) => g.entryIdsPage({ limit: 1000 }),
      (g) => g.entryIdsPage({ limit: 2 }),
      (g) => g.rejected(TENANT_A, [rejectionDigest(REFUSED), rejectionDigest('nothing'), rejectionDigest(REFUSED)]),
      (g) => g.rejected(TENANT_B, [rejectionDigest(REFUSED)]),
      (g) => g.particleIds(),
      (g) => g.saveParticles([particle(id('kept'), 0.75)]),
      (_g, s) => s.vectors.stored('particles', named('kept', 'edited')),
      (g) => g.duplicateCandidates(),
      (g) => g.unprofiledTopicSummaries({ limit: 10 }),
      (g) => g.dirtyGraphTenants(),
      (g) => g.markGraphDrained(TENANT_A, 10),
      (g) => g.auditEachRow([{ tenantId: TENANT_A, actor: 'test', op: 'mv_rescue', targetId: id('kept') }]),
    ]);
    expect(valueAt<{ ids: string[] }>(sqlite.outcomes, 1).ids).toHaveLength(2);
    expect(valueAt<unknown[]>(sqlite.outcomes, 2)).toHaveLength(1);
    expect(valueAt<string[]>(sqlite.outcomes, 4)).toEqual(named('kept', 'edited'));
    expect(valueAt<{ rows: MemoryEntry[] }>(sqlite.outcomes, 7).rows.map((e) => e.id)).toEqual(named('twin1', 'twin2'));
  });

  it('settles dirty summaries once each, keeping tombstoned content out with a refusal row', async () => {
    const clean = { tenantId: TENANT_A, actor: 'buildDag', op: 'summary_marked_clean' as const, targetId: id('fresh') };
    const sqlite = await conforms([
      (g) => g.dirtySummaries(2),
      (g) => g.settleSummary(rebuilt('topic', 'alice runs billing and payroll for acme')),
      (g) => g.settleSummary(rebuilt('topic', 'a second rebuild that lost the race')),
      (g) => g.settleSummary(rebuilt('refusing', REFUSED)),
      (g) => g.settleSummary({ id: id('fresh'), tenantId: TENANT_B, actor: 'buildDag', audit: [clean] }),
      (g) => g.settleSummary({ id: id('fresh'), tenantId: TENANT_A, actor: 'buildDag', audit: [clean] }),
      (g) => g.dirtySummaries(10),
      read(['topic', 'refusing', 'fresh']),
    ]);
    expect(valueAt<{ more: boolean }>(sqlite.outcomes, 0).more).toBe(true);
    expect(sqlite.outcomes.slice(1, 6)).toEqual([
      { value: { changed: true, refused: false } },
      { value: { changed: false, refused: false } },
      { value: { changed: true, refused: true } },
      { value: { changed: false, refused: false } },
      { value: { changed: true, refused: false } },
    ]);
    expect(sqlite.audit.slice(-4).map((row) => row.op)).toEqual([
      'summary_rebuilt',
      'reject_refusal',
      'summary_rebuilt',
      'summary_marked_clean',
    ]);
  });

  it('commits the flush and the dormant expiry, then records the sleep', async () => {
    const edited = { ...rows.edited!, content: 'the deploy window is thursday' };
    const fading = { entry: rows.fading!, strength: 0.01, reason: 'decay' as const, dormantAt: AT };
    const flush: SleepCommit['flush'] = {
      components: [
        {
          refreshes: [{ id: id('kept'), strength: 0.42 }],
          writes: [edited],
          deletes: named('gone', 'pinned'),
          dormant: [fading],
        },
      ],
      snapshot: new Map([[id('edited'), rows.edited!]]),
    };
    const conflict = { memory_a_id: id('twin1'), memory_b_id: id('twin2'), reason: 'contradiction', score: 0.9 };
    const sqlite = await conforms([
      (g) => g.commit({ flush, expireBefore: '2020-01-01T00:00:00.000Z', dryRun: false, holdMs: 0 }),
      (g) => g.commit({ flush: null, expireBefore: '2030-01-01T00:00:00.000Z', dryRun: true, holdMs: 0 }),
      (g) => g.recordSleep({ conflicts: [conflict], at: AT, decayed: 1, merged: 0, removed: 1 }),
      (g) => g.begin(DEFAULT_HALF_LIFE_DAYS, { dryRun: true, actor: 'test' }),
      (_g, s) => s.conflicts.list({ tenantId: TENANT_A, status: 'open', limit: 10 }),
      (_g, s) => s.dormant.list(TENANT_A, null, {}),
      read(['kept', 'edited', 'gone', 'pinned', 'fading', 'twin1']),
    ]);
    expect(sqlite.outcomes.slice(0, 2)).toEqual([
      { value: { removedIds: named('gone', 'fading'), expired: 1 } },
      { value: { removedIds: [], expired: 2 } },
    ]);
    expect(valueAt(sqlite.outcomes, 3)).toMatchObject({ sleepCount: 1, recentRuns: [AT] });
  });
});
