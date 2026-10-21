// The dashboard's tallies group live memories by origin project and count bands, layers, conflicts and embeddings over
// that one population.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { memoryFacts, seriesDay } from '../../src/base/memory/memory-facts.js';
import { AT_RISK_BELOW } from '../../src/base/memory/strength-bands.js';
import { quarantineScopeFor } from '../../src/domain/trust/quarantine.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { storedVectorIds } from '../../src/db/vector-store.js';
import { isLiveMemory } from '../../src/api/dashboard/live.js';
import { buildOverview } from '../../src/api/dashboard/overview.js';
import { buildMemoryPage, type MemoryQuery } from '../../src/api/dashboard/queries.js';
import type { Overview, ProjectSummary } from '../../src/api/dashboard/types.js';
import type { DashboardTotals, ProjectTally } from '../../src/store/port/dashboard-reads.js';
import { dashboardOf, embed, isoAgo, makeStore, NOW, seed, type TmpStore } from '../_helpers/dashboard-fixture.js';
import { countMatching, recordStatementsAsync } from '../_helpers/count-statements.js';
import {
  listMemoryConflicts,
  replaceDetectedConflicts,
  resolveConflictKeeping,
  loadAllEntries,
} from '../_helpers/root-forms.js';

let store: TmpStore;

beforeEach(() => {
  store = makeStore('hippo-dash-snapshot');
});

afterEach(() => {
  store.cleanup();
});

async function overview(): Promise<Overview> {
  const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
  try {
    return await buildOverview(reads, await clock.at('default'));
  } finally {
    await reads.close();
  }
}

async function totals(): Promise<DashboardTotals> {
  const { reads } = dashboardOf(store.hippoRoot, () => NOW);
  try {
    return await reads.totals('default', NOW);
  } finally {
    await reads.close();
  }
}

const summaryOf = (o: Overview, key: string): ProjectSummary => o.projects.find((p) => p.key === key)!;

// Ten day half-life, just retrieved: strong today, under 0.2 in thirty days.
const AT_RISK = { halfLifeDays: 10, created: isoAgo(0), lastRetrieved: isoAgo(0) } as const;
// Hundred day half-life, last used 150 days ago: weak today, still above 0.2 in thirty days.
const FADING = { halfLifeDays: 100, created: isoAgo(150), lastRetrieved: isoAgo(150) } as const;

const EVERY_ROW: MemoryQuery = {
  offset: 0,
  limit: 50,
  sort: 'strength',
  dir: 'asc',
  chip: 'all',
  layers: [0, 1, 2, 3],
  brush: { amin: -Infinity, amax: Infinity, smin: -Infinity, smax: Infinity },
  q: null,
};

/** The tally a fold over whole entries gives, the way the in-memory snapshot counted before SQL did. */
function foldOf(entries: readonly MemoryEntry[], vectors: ReadonlySet<string>): Omit<ProjectTally, 'openConflicts'>[] {
  const byOrigin = new Map<string | null, MemoryEntry[]>();
  const ordered = [...entries].sort((a, b) => (a.created + '\u0001' + a.id < b.created + '\u0001' + b.id ? -1 : 1));
  for (const e of ordered) byOrigin.set(e.originProject ?? null, [...(byOrigin.get(e.originProject ?? null) ?? []), e]);
  return [...byOrigin].map(([origin, rows]) => {
    const facts = rows.map((e) => memoryFacts(e, NOW, {}));
    const count = (pick: (i: number) => boolean): number => rows.filter((_, i) => pick(i)).length;
    const createdDays = Array.from({ length: 91 }, () => 0);
    for (const e of rows) {
      createdDays[seriesDay(Number.isFinite(Date.parse(e.created)) ? Date.parse(e.created) : NOW, NOW)]++;
    }
    return {
      origin,
      live: rows.length,
      // SAFETY: four band indexes map to four counts, the tuple's length.
      bands: [0, 1, 2, 3].map((b) => count((i) => facts[i].band === b)) as ProjectTally['bands'],
      // SAFETY: four layer indexes map to four counts, the tuple's length.
      layers: [0, 1, 2, 3].map((l) => count((i) => facts[i].layer === l)) as ProjectTally['layers'],
      pinned: count((i) => rows[i].pinned),
      embedded: count((i) => vectors.has(rows[i].id)),
      weakNow: count((i) => facts[i].strength < AT_RISK_BELOW),
      lastRetrievedDays: Math.min(...facts.map((f) => f.lastRetrievedDays)),
      maxAgeDays: Math.max(0, ...facts.map((f) => f.ageDays)),
      firstCreatedMs: Math.min(...rows.map((e) => Date.parse(e.created))),
      createdDays,
    };
  });
}

describe('dashboard tallies', () => {
  it('groups by origin project, with Global for an empty origin and Unassigned for null', async () => {
    seed(store.hippoRoot, 'alpha one');
    seed(store.hippoRoot, 'alpha two');
    seed(store.hippoRoot, 'global one', { originProject: '' });
    seed(store.hippoRoot, 'unassigned one', { originProject: null });

    const o = await overview();

    const live = Object.fromEntries(o.projects.map((p) => [p.key, p.live]));
    expect(live).toEqual({ 'p:alpha': 2, global: 1, unassigned: 1 });
    expect(summaryOf(o, 'global').kind).toBe('global');
    expect(summaryOf(o, 'unassigned').name).toBe('Unassigned');
  });

  it('puts a pinned memory in the pinned band and judges at risk on projected 30d strength', async () => {
    seed(store.hippoRoot, 'pinned and decaying', { ...AT_RISK, pinned: true });
    seed(store.hippoRoot, 'decaying fast', AT_RISK);
    seed(store.hippoRoot, 'slow decay');
    seed(store.hippoRoot, 'long unused', FADING);

    const alpha = summaryOf(await overview(), 'p:alpha');

    expect(alpha.bands).toEqual({ pinned: 1, strong: 1, fading: 1, atRisk: 1 });
    expect(alpha.atRisk).toBe(1);
    expect(alpha.pinned).toBe(1);
  });

  it('keeps bands and layers summing to live, with a trace memory counted as live', async () => {
    seed(store.hippoRoot, 'episodic one');
    seed(store.hippoRoot, 'semantic one', { layer: Layer.Semantic });
    seed(store.hippoRoot, 'trace one', { layer: Layer.Trace });
    seed(store.hippoRoot, 'buffer one', { layer: Layer.Buffer, ...AT_RISK });

    const alpha = summaryOf(await overview(), 'p:alpha');
    const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

    expect(alpha.live).toBe(4);
    expect(sum(alpha.bands)).toBe(alpha.live);
    expect(sum(alpha.layers)).toBe(alpha.live);
    expect(alpha.layers.trace).toBe(1);
  });

  it('counts only open conflicts whose members are both live', async () => {
    const a1 = seed(store.hippoRoot, 'deploy target is fly');
    const a2 = seed(store.hippoRoot, 'deploy target is render');
    const b1 = seed(store.hippoRoot, 'build tool is webpack', { originProject: 'beta' });
    const q = seed(store.hippoRoot, 'quarantined claim', { scope: quarantineScopeFor(null) });
    const r1 = seed(store.hippoRoot, 'region is eu');
    const r2 = seed(store.hippoRoot, 'region is us');
    replaceDetectedConflicts(store.hippoRoot, [
      { memory_a_id: a1.id, memory_b_id: a2.id, reason: 'inside alpha', score: 0.9 },
      { memory_a_id: a1.id, memory_b_id: b1.id, reason: 'across projects', score: 0.8 },
      { memory_a_id: a2.id, memory_b_id: q.id, reason: 'quarantined member', score: 0.7 },
      { memory_a_id: r1.id, memory_b_id: r2.id, reason: 'already settled', score: 0.6 },
    ]);
    const settled = listMemoryConflicts(store.hippoRoot, 'open', 'default').find(
      (c) => c.reason === 'already settled',
    )!;
    expect(resolveConflictKeeping(store.hippoRoot, 'default', settled.id, r1.id)).toBe(true);

    const o = await overview();
    const { reads, clock } = dashboardOf(store.hippoRoot, () => NOW);
    const page = await buildMemoryPage(reads, await clock.at('default'), 'p:alpha', EVERY_ROW);
    await reads.close();

    expect(o.kpis.find((k) => k.id === 'openConflicts')?.value).toBe(2);
    // The cross-project conflict counts once in each project it touches; the one inside alpha counts once.
    expect(summaryOf(o, 'p:alpha').openConflicts).toBe(2);
    expect(summaryOf(o, 'p:beta').openConflicts).toBe(1);
    expect(page?.rows.map((r) => r.id)).not.toContain(q.id);
    expect(page?.counts.conflict).toBe(2);
  });

  it('counts embedded memories from memory_vectors and reports coverage over live memories', async () => {
    const one = seed(store.hippoRoot, 'embedded one');
    const two = seed(store.hippoRoot, 'embedded two');
    seed(store.hippoRoot, 'not embedded');
    seed(store.hippoRoot, 'also not embedded');
    const old = seed(store.hippoRoot, 'replaced', { kind: 'superseded', supersededBy: one.id });
    // memory_vectors has no foreign key, so a vector for a superseded or deleted memory must not count.
    embed(store.hippoRoot, [one.id, two.id, old.id, 'orphan-id']);

    const o = await overview();

    expect(summaryOf(o, 'p:alpha').embedded).toBe(2);
    expect(o.embeddingCoverage).toBe(0.5);
  });

  it("tallies in SQL what a fold over the tenant's whole rows counts", async () => {
    const root = store.hippoRoot;
    const pinned = seed(root, 'pinned with tags', { pinned: true, tags: ['Deploy', 'error'], confidence: 'verified' });
    const wrong = seed(root, 'marked wrong twice', {
      outcomeNegative: 2,
      emotionalValence: 'negative',
      retrievalCount: 7,
    });
    seed(root, 'raw global row', { kind: 'raw', originProject: '', layer: Layer.Buffer, ...AT_RISK });
    seed(root, 'unassigned and long unused', { originProject: null, ...FADING });
    // The prefix test is exact, so a scope that differs only in case stays live.
    seed(root, 'scope that only looks quarantined', { scope: 'Quarantine:private:team', originProject: 'beta' });
    seed(root, 'x'.repeat(300), { originProject: 'beta', layer: Layer.Semantic });
    seed(root, 'replaced by the pinned one', { supersededBy: pinned.id });
    seed(root, 'superseded by kind alone', { kind: 'superseded' });
    seed(root, 'archived and replaced', { kind: 'archived', supersededBy: wrong.id });
    seed(root, 'archived', { kind: 'archived' });
    seed(root, 'quarantined', { scope: quarantineScopeFor('team:eng') });
    seed(root, 'quarantined and archived', { scope: quarantineScopeFor(null), kind: 'archived' });
    seed(root, 'another tenant', { tenantId: 'other' });
    replaceDetectedConflicts(root, [
      { memory_a_id: pinned.id, memory_b_id: wrong.id, reason: 'inside alpha', score: 0.9 },
    ]);
    embed(root, [pinned.id, wrong.id]);

    const got = await totals();
    const db = openHippoDb(root);
    let vectors: Set<string>;
    try {
      vectors = storedVectorIds(db);
    } finally {
      closeHippoDb(db);
    }
    const live = loadAllEntries(root, 'default').filter(isLiveMemory);

    expect(got.excluded).toEqual({ superseded: 3, archived: 1, quarantined: 2 });
    expect(got.openConflicts).toBe(1);
    expect(got.projects.map(({ openConflicts: _, ...rest }) => rest)).toEqual(foldOf(live, vectors));
    expect(got.projects.map((p) => [p.origin, p.openConflicts])).toEqual(
      got.projects.map((p) => [p.origin, p.origin === 'alpha' ? 1 : 0]),
    );
  });

  it("reads vectors only for its own tenant's rows, never the whole vector table", async () => {
    const root = store.hippoRoot;
    const one = seed(root, 'embedded one');
    seed(root, 'not embedded');
    embed(root, [one.id]);
    const rowsRead = async (): Promise<number> => {
      const log = await recordStatementsAsync(() => overview());
      expect(log.result.embeddingCoverage).toBe(0.5);
      expect(countMatching(log.statements, /FROM memory_vectors$/)).toBe(0);
      return log.rowsRead;
    };
    const before = await rowsRead();
    const other = seed(root, 'another tenant', { tenantId: 'other' });
    embed(root, [other.id, ...Array.from({ length: 40 }, (_, i) => `orphan-${i}`)]);
    expect(await rowsRead()).toBe(before);
  });

  it('answers the detail embedded flag from the vector table at each read', async () => {
    const root = store.hippoRoot;
    const live = seed(root, 'embedded live');
    const plain = seed(root, 'not embedded');
    const replaced = seed(root, 'embedded but replaced', { supersededBy: live.id });
    embed(root, [live.id, replaced.id, 'orphan-id']);
    const ids = [live.id, plain.id, replaced.id];
    const { reads } = dashboardOf(root, () => NOW);
    try {
      expect(await Promise.all([...ids, 'orphan-id'].map((id) => reads.hasVector(id)))).toEqual([
        true,
        false,
        true,
        true,
      ]);
      embed(root, [plain.id]);
      expect(await Promise.all(ids.map((id) => reads.hasVector(id)))).toEqual([true, true, true]);
    } finally {
      await reads.close();
    }
  });
});
