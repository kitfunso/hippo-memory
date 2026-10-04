// The snapshot groups live memories by origin project and counts bands, layers, conflicts and embeddings over that one population.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Layer } from '../src/memory.js';
import { listMemoryConflicts, replaceDetectedConflicts, resolveConflict } from '../src/store.js';
import { quarantineScopeFor } from '../src/quarantine.js';
import { createSnapshotService } from '../src/dashboard-snapshot.js';
import { buildOverview } from '../src/dashboard-queries.js';
import { embed, isoAgo, makeStore, NOW, seed, type TmpStore } from './_helpers/dashboard-fixture.js';

let store: TmpStore;

beforeEach(() => {
  store = makeStore('hippo-dash-snapshot');
});

afterEach(() => {
  store.cleanup();
});

function snapshot() {
  const service = createSnapshotService(store.hippoRoot, () => NOW);
  try {
    return service.get('default');
  } finally {
    service.close();
  }
}

// Ten day half-life, just retrieved: strong today, under 0.2 in thirty days.
const AT_RISK = { half_life_days: 10, created: isoAgo(0), last_retrieved: isoAgo(0) } as const;
// Hundred day half-life, last used 150 days ago: weak today, still above 0.2 in thirty days.
const FADING = { half_life_days: 100, created: isoAgo(150), last_retrieved: isoAgo(150) } as const;

describe('dashboard snapshot', () => {
  it('groups by origin project, with Global for an empty origin and Unassigned for null', () => {
    seed(store.hippoRoot, 'alpha one');
    seed(store.hippoRoot, 'alpha two');
    seed(store.hippoRoot, 'global one', { origin_project: '' });
    seed(store.hippoRoot, 'unassigned one', { origin_project: null });

    const snap = snapshot();

    const live = Object.fromEntries(snap.projects.map((p) => [p.summary.key, p.summary.live]));
    expect(live).toEqual({ 'p:alpha': 2, global: 1, unassigned: 1 });
    expect(snap.byKey.get('global')?.summary.kind).toBe('global');
    expect(snap.byKey.get('unassigned')?.summary.name).toBe('Unassigned');
  });

  it('puts a pinned memory in the pinned band and judges at risk on projected 30d strength', () => {
    seed(store.hippoRoot, 'pinned and decaying', { ...AT_RISK, pinned: true });
    seed(store.hippoRoot, 'decaying fast', AT_RISK);
    seed(store.hippoRoot, 'slow decay');
    seed(store.hippoRoot, 'long unused', FADING);

    const alpha = snapshot().byKey.get('p:alpha')!.summary;

    expect(alpha.bands).toEqual({ pinned: 1, strong: 1, fading: 1, atRisk: 1 });
    expect(alpha.atRisk).toBe(1);
    expect(alpha.pinned).toBe(1);
  });

  it('keeps bands and layers summing to live, with a trace memory counted as live', () => {
    seed(store.hippoRoot, 'episodic one');
    seed(store.hippoRoot, 'semantic one', { layer: Layer.Semantic });
    seed(store.hippoRoot, 'trace one', { layer: Layer.Trace });
    seed(store.hippoRoot, 'buffer one', { layer: Layer.Buffer, ...AT_RISK });

    const alpha = snapshot().byKey.get('p:alpha')!.summary;
    const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

    expect(alpha.live).toBe(4);
    expect(sum(alpha.bands)).toBe(alpha.live);
    expect(sum(alpha.layers)).toBe(alpha.live);
    expect(alpha.layers.trace).toBe(1);
  });

  it('counts only open conflicts whose members are both live', () => {
    const a1 = seed(store.hippoRoot, 'deploy target is fly');
    const a2 = seed(store.hippoRoot, 'deploy target is render');
    const b1 = seed(store.hippoRoot, 'build tool is webpack', { origin_project: 'beta' });
    const q = seed(store.hippoRoot, 'quarantined claim', { scope: quarantineScopeFor(null) });
    const r1 = seed(store.hippoRoot, 'region is eu');
    const r2 = seed(store.hippoRoot, 'region is us');
    replaceDetectedConflicts(store.hippoRoot, [
      { memory_a_id: a1.id, memory_b_id: a2.id, reason: 'inside alpha', score: 0.9 },
      { memory_a_id: a1.id, memory_b_id: b1.id, reason: 'across projects', score: 0.8 },
      { memory_a_id: a2.id, memory_b_id: q.id, reason: 'quarantined member', score: 0.7 },
      { memory_a_id: r1.id, memory_b_id: r2.id, reason: 'already settled', score: 0.6 },
    ]);
    const settled = listMemoryConflicts(store.hippoRoot, 'open', 'default').find((c) => c.reason === 'already settled')!;
    expect(resolveConflict(store.hippoRoot, settled.id, r1.id, false, 'default')).not.toBeNull();

    const snap = snapshot();
    const overview = buildOverview(snap);

    expect(snap.openConflicts).toBe(2);
    expect(overview.kpis.find((k) => k.id === 'openConflicts')?.value).toBe(2);
    // The cross-project conflict counts once in each project it touches; the one inside alpha counts once.
    expect(snap.byKey.get('p:alpha')?.summary.openConflicts).toBe(2);
    expect(snap.byKey.get('p:beta')?.summary.openConflicts).toBe(1);
    expect(snap.facts.find((f) => f.id === q.id)).toBeUndefined();
  });

  it('counts embedded memories from memory_vectors and reports coverage over live memories', () => {
    const one = seed(store.hippoRoot, 'embedded one');
    const two = seed(store.hippoRoot, 'embedded two');
    seed(store.hippoRoot, 'not embedded');
    seed(store.hippoRoot, 'also not embedded');
    const old = seed(store.hippoRoot, 'replaced', { kind: 'superseded', superseded_by: one.id });
    // memory_vectors has no foreign key, so a vector for a superseded or deleted memory must not count.
    embed(store.hippoRoot, [one.id, two.id, old.id, 'orphan-id']);

    const snap = snapshot();

    expect(snap.byKey.get('p:alpha')?.summary.embedded).toBe(2);
    expect(snap.embeddingCoverage).toBe(0.5);
  });
});
