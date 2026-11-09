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
import type { DirtySummaries, SleepCommit, SummarySettle } from '../../src/base/ports/store/consolidation.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant/dormant-rows.js';
import { insertRejectedValue } from '../../src/store/sqlite/review/rejection.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  runOnFixture,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type Outcome,
  type TwoTenantFixture,
  valueAt,
} from '../_helpers/store-conformance.js';
import { appendSessionEvent, writeEntry } from '../_helpers/root-forms.js';

type MarkPage = Awaited<ReturnType<NonNullable<StoreGroups['consolidation']['emptyExtractions']>>>;

const START = Date.parse('2026-03-01T12:00:00.000Z');
const AT = '2026-02-15T00:00:00.000Z';
const REFUSED = 'the summary nobody wants';
const HELD_UNTIL = '2026-03-02T00:00:00.000Z';
const ABSENT = 'mem_absent';
const STALE_MARK = JSON.stringify({ digest: 'aaaaaaaaaaaaaaaa', at: AT });
const STALE_HOLD = JSON.stringify({ failures: 5, retryAfter: '2999-01-01T00:00:00.000Z' });
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
    // A hold left behind for a clean summary: the sweep drops it, so it cannot hold the row once it is dirty again.
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(`rebuild_hold:${rows.topicB!.id}`, STALE_HOLD);
    // Marks as an earlier sleep left them: two for sources that left, one that is not JSON.
    const mark = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
    db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(id('kept'), id('replaced'));
    mark.run(`empty_extraction:${id('replaced')}`, STALE_MARK);
    mark.run(`empty_extraction:${ABSENT}`, STALE_MARK);
    mark.run(`empty_extraction:${id('gone')}`, 'not json');
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
  seedRow('replaced', 'the old ingress was haproxy');
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

const nameOf = (entryId: string): string => Object.keys(rows).find((n) => rows[n]!.id === entryId) ?? entryId;

/** What a dirtySummaries answer holds: each summary's stored failure count by row name, and `held`. */
function dirtyView(outcomes: readonly Outcome<unknown>[], i: number) {
  const { summaries, held } = valueAt<DirtySummaries>(outcomes, i);
  return { failures: Object.fromEntries(summaries.map((s) => [nameOf(s.summary.id), s.failures])), held };
}

const failedRebuild = (
  name: string,
  priorFailures: number,
  failures: number,
  retryAfter: string | null,
  tenantId = TENANT_A,
) => ({ id: id(name), tenantId, priorFailures, failures, retryAfter });

const laterChild = (parent: string, tenantId: string): MemoryEntry => ({
  ...createMemory(`a later fact about ${parent}`, {
    tenantId,
    dagLevel: DAG_LEVEL.extracted,
    dagParentId: id(parent),
    tags: ['extracted'],
  }),
  originProject: 'proj',
});

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

  it('holds a summary after failed rebuilds: skips it until its time, counts failures once, and a settle ends the hold', async () => {
    const before = '2026-03-01T13:00:00.000Z';
    const sqlite = await conforms([
      (g) => g.dirtySummaries(10),
      (g) => g.noteRebuildFailures!([failedRebuild('topic', 0, 3, HELD_UNTIL)]),
      (g) => g.dirtySummaries(10, before),
      (g) => g.dirtySummaries(10),
      (g) => g.dirtySummaries(10, HELD_UNTIL),
      // A stale prior count and another tenant's row write nothing.
      (g) =>
        g.noteRebuildFailures!([
          failedRebuild('refusing', 5, 6, HELD_UNTIL),
          failedRebuild('fresh', 0, 1, null, TENANT_B),
        ]),
      (g) => g.dirtySummaries(10, before),
      (g) => g.settleSummary(rebuilt('topic', 'alice runs billing and payroll for acme')),
      // The row is clean now, so a late note writes nothing.
      (g) => g.noteRebuildFailures!([failedRebuild('topic', 0, 1, null)]),
      (_g, s) => s.entryWrites.writeEntry({ entry: laterChild('topic', TENANT_A), actor: 'cli' }),
      (_g, s) => s.entryWrites.writeEntry({ entry: laterChild('topicB', TENANT_B), actor: 'cli' }),
      (g) => g.dirtySummaries(10, before),
    ]);
    // Each note resolved, so the reads below show what it wrote rather than a rejected call.
    for (const i of [1, 5, 8]) expect(valueAt(sqlite.outcomes, i)).toBeUndefined();
    const clean = { topic: 0, refusing: 0, fresh: 0 };
    expect(dirtyView(sqlite.outcomes, 0)).toEqual({ failures: clean, held: undefined });
    expect(dirtyView(sqlite.outcomes, 2)).toEqual({ failures: { refusing: 0, fresh: 0 }, held: 1 });
    expect(dirtyView(sqlite.outcomes, 3)).toEqual({ failures: { ...clean, topic: 3 }, held: undefined });
    expect(dirtyView(sqlite.outcomes, 4)).toEqual({ failures: { ...clean, topic: 3 }, held: 0 });
    expect(dirtyView(sqlite.outcomes, 6)).toEqual({ failures: { refusing: 0, fresh: 0 }, held: 1 });
    // The settle cleared topic's hold and the sweep cleared topicB's stale one, so neither is held again.
    expect(dirtyView(sqlite.outcomes, 11)).toEqual({ failures: { ...clean, topicB: 0 }, held: 0 });
  });

  it('keeps empty extraction marks for live sources only, pages them by source id, and drops those that left', async () => {
    const mark = (name: string, digest: string) => ({ id: id(name), digest, at: AT });
    const live = named('kept', 'edited', 'gone').sort();
    const sqlite = await conforms([
      (g) => g.emptyExtractions!({ limit: 10 }),
      // The first note drops the marks left for a superseded and a missing source, and replaces the one that is not JSON.
      (g) =>
        g.noteEmptyExtractions!({
          mark: [
            mark('kept', 'bbbbbbbbbbbbbbbb'),
            mark('edited', 'cccccccccccccccc'),
            mark('gone', 'dddddddddddddddd'),
          ],
          clear: [],
        }),
      (g) => g.emptyExtractions!({ limit: 2 }),
      (g) => g.emptyExtractions!({ limit: 2, after: live[1] }),
      // A superseded and a missing source take no mark.
      (g) =>
        g.noteEmptyExtractions!({
          mark: [mark('replaced', 'eeeeeeeeeeeeeeee'), { ...mark('kept', 'x'), id: ABSENT }],
          clear: [],
        }),
      (g) => g.noteEmptyExtractions!({ mark: [mark('edited', 'ffffffffffffffff')], clear: [id('kept')] }),
      (g) => g.emptyExtractions!({ limit: 10 }),
    ]);
    for (const i of [1, 4, 5]) expect(valueAt(sqlite.outcomes, i)).toBeUndefined();
    const marks = (i: number) => valueAt<MarkPage>(sqlite.outcomes, i).marks;
    expect(marks(0).map((m) => m.id)).toEqual([ABSENT, id('replaced')].sort());
    expect(valueAt<MarkPage>(sqlite.outcomes, 2).next).toBe(live[1]);
    expect(marks(2).map((m) => m.id)).toEqual(live.slice(0, 2));
    expect(valueAt<MarkPage>(sqlite.outcomes, 3).next).toBeNull();
    expect(marks(3).map((m) => m.id)).toEqual(live.slice(2));
    expect(marks(6)).toEqual(
      named('edited', 'gone')
        .sort()
        .map((markId) => expect.objectContaining({ id: markId })),
    );
    expect(marks(6).find((m) => m.id === id('edited'))).toEqual(mark('edited', 'ffffffffffffffff'));
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
    const conflict = { memoryAId: id('twin1'), memoryBId: id('twin2'), reason: 'contradiction', score: 0.9 };
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
