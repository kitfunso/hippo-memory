/**
 * DAG consolidation hierarchy — slice 1 tests (real DB, NO mocks).
 *
 * Covers the merge-pass-as-DAG-node mechanism from
 * docs/plans/2026-06-09-dag-consolidation-slice1.md:
 *   (a) compressor: summary tokens < sum(children) AND all k=3 answer tokens survive
 *   (b) merge pass: dag_level=2 + 'dag-summary' + descendant_count on summary;
 *       dag_parent_id set AND dag_level still 0 on children
 *   (c) substituteDagSummaries unit: drops >=2 present children, keeps lone
 *       children + summaries; pure + deterministic
 *   (d) tombstone: merge over 3 children, supersede A->A', rebuild omits A's
 *       stale token, includes A''s token, drillDown omits A
 *   (e) physicsSearch budget pack at fixed B demotes >=2 children when the
 *       summary is packed
 *
 * Each test isolates a temp HIPPO_HOME under os.tmpdir() (never cwd/.hippo or
 * the global store) so tests/_real-store-guard.ts cannot false-positive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  initStore,
  writeEntry,
  loadAllEntries,
  readEntry,
} from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import {
  consolidate,
  compressContents,
  compressCluster,
} from '../src/consolidate.js';
import {
  physicsSearch,
  substituteDagSummaries,
  estimateTokens,
  isDagSummary,
} from '../src/search.js';
import { rebuildDirtySummaries } from '../src/dag.js';
import { supersede, drillDown } from '../src/api.js';
import { DEFAULT_PHYSICS_CONFIG } from '../src/physics-config.js';
import { savePhysicsState } from '../src/physics-state.js';
import type { PhysicsParticle } from '../src/physics.js';
import { openHippoDb } from '../src/db.js';

const PC = { ...DEFAULT_PHYSICS_CONFIG, enabled: true };
const ADMIN = (root: string) => ({
  hippoRoot: root,
  tenantId: 'default',
  actor: { subject: 'cli', role: 'admin' as const },
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-cons-hier-'));
  initStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (a) Zero-dep extractive compressor
// ---------------------------------------------------------------------------

describe('compressor (zero-dep extractive)', () => {
  it('produces fewer tokens than the sum of children for a k=3 paraphrase cluster', () => {
    // Three near-duplicate paraphrases of ONE fact (connective-only variation).
    const children = [
      'Project Falcon deadline is ANS4242. The engineering milestone fixed during autumn hardware bringup.',
      'Project Falcon deadline equals ANS4242. The engineering milestone fixed during autumn hardware bringup.',
      'Project Falcon deadline namely ANS4242. The engineering milestone fixed during autumn hardware bringup.',
    ];
    const out = compressContents(children);
    const childrenTokens = children.reduce((s, c) => s + estimateTokens(c), 0);
    expect(estimateTokens(out)).toBeLessThan(childrenTokens);
    // the single distinct answer token survives
    expect(out).toContain('ANS4242');
    // no boilerplate prefix
    expect(out.startsWith('[Consolidated')).toBe(false);
  });

  it('keeps ALL distinct answer tokens when the cluster carries multiple facts', () => {
    // Three lines, each a DISTINCT answer (distinct topics + tokens). None are
    // paraphrases of each other, so all three must survive.
    const children = [
      'Atlas budget cap is ANS1001. finance ceiling locked after procurement spreadsheet review.',
      'Nova release owner is ANS2002. staffing assignment recorded in launch readiness tracker.',
      'Orion vendor contract is ANS3003. legal agreement signed following supplier diligence calls.',
    ];
    const out = compressContents(children);
    for (const t of ['ANS1001', 'ANS2002', 'ANS3003']) {
      expect(out, `distinct answer ${t} must survive`).toContain(t);
    }
  });

  it('is deterministic: same input => byte-identical output (order-independent)', () => {
    const a = [
      'Vega staffing plan is ANS5005. headcount allocation confirmed by quarterly resourcing board.',
      'Vega staffing plan equals ANS5005. headcount allocation confirmed by quarterly resourcing board.',
      'Lyra compliance review is ANS6006. audit checkpoint cleared once regulator questionnaire returned.',
    ];
    const b = [a[2], a[0], a[1]]; // shuffled input
    expect(compressContents(a)).toBe(compressContents(b));
    // and stable across repeated calls
    expect(compressContents(a)).toBe(compressContents(a));
  });

  it('compressCluster delegates to compressContents over entry content', () => {
    const e1 = createMemory('cache refresh failure data pipeline error here', { layer: Layer.Episodic });
    const e2 = createMemory('cache refresh failure data pipeline problem here', { layer: Layer.Episodic });
    expect(compressCluster([e1, e2])).toBe(compressContents([e1.content, e2.content]));
  });
});

// ---------------------------------------------------------------------------
// (b) Merge pass emits a real L2 DAG node + links children
// ---------------------------------------------------------------------------

describe('merge pass emits a DAG summary node', () => {
  it('sets dag_level=2 + dag-summary tag + descendant_count on the summary; dag_parent_id + dag_level=0 on children', async () => {
    // Two highly-similar episodics -> one merge cluster.
    const e1 = createMemory('Pegasus rollout window is ANS7007 deployment schedule frozen ahead of regional traffic ramp', { layer: Layer.Episodic });
    const e2 = createMemory('Pegasus rollout window namely ANS7007 deployment schedule frozen ahead of regional traffic ramp', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    const result = await consolidate(tmpDir, { now: new Date() });
    expect(result.merged).toBeGreaterThan(0);
    expect(result.semanticCreated).toBeGreaterThan(0);

    const all = loadAllEntries(tmpDir);
    const summaries = all.filter((e) => e.layer === Layer.Semantic && e.tags.includes('dag-summary'));
    expect(summaries.length).toBe(1);
    const summary = summaries[0];

    // summary node shape
    expect(summary.dag_level).toBe(2);
    expect(isDagSummary(summary)).toBe(true);
    expect(summary.descendant_count).toBe(2);
    expect(summary.earliest_at).toBeTruthy();
    expect(summary.latest_at).toBeTruthy();
    expect(summary.source).toBe('consolidation');
    // no boilerplate prefix; carries the answer token
    expect(summary.content.startsWith('[Consolidated')).toBe(false);
    expect(summary.content).toContain('ANS7007');

    // children kept (not deleted), linked, and STILL dag_level 0
    const children = all.filter((e) => e.dag_parent_id === summary.id);
    expect(children.length).toBe(2);
    for (const c of children) {
      expect(c.dag_level).toBe(0);
      expect(c.dag_parent_id).toBe(summary.id);
    }
    // source episodics survive
    expect(all.some((e) => e.id === e1.id)).toBe(true);
    expect(all.some((e) => e.id === e2.id)).toBe(true);
  });

  it('does NOT write the inert strength*0.3 weakening (children retain full strength)', async () => {
    const e1 = createMemory('Draco migration target is ANS8008 cutover target chosen after staging rehearsal dry runs', { layer: Layer.Episodic });
    const e2 = createMemory('Draco migration target now ANS8008 cutover target chosen after staging rehearsal dry runs', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    await consolidate(tmpDir, { now: new Date() });
    const all = loadAllEntries(tmpDir);
    const children = all.filter((e) => e.dag_parent_id && e.layer === Layer.Episodic);
    expect(children.length).toBe(2);
    // 0.3 weakening removed: a freshly-created episodic decays only by the tiny
    // read-time age factor, so strength stays well above the old 0.3 product.
    for (const c of children) {
      expect(c.strength).toBeGreaterThan(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) substituteDagSummaries pure unit
// ---------------------------------------------------------------------------

describe('substituteDagSummaries (pure unit)', () => {
  function entry(id: string, fields: Partial<MemoryEntry> = {}): { entry: MemoryEntry } {
    const e = createMemory(`content for ${id} padded out a little`, { layer: Layer.Episodic });
    return { entry: { ...e, id, ...fields } };
  }

  it('drops >=2 present children of a present summary, keeps the summary', () => {
    const summary = entry('sum1', { dag_level: 2 });
    const c1 = entry('c1', { dag_parent_id: 'sum1' });
    const c2 = entry('c2', { dag_parent_id: 'sum1' });
    const out = substituteDagSummaries([summary, c1, c2], { minChildren: 2 });
    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain('sum1');
    expect(ids).not.toContain('c1');
    expect(ids).not.toContain('c2');
  });

  it('keeps a lone child (only 1 present child < minChildren)', () => {
    const summary = entry('sum1', { dag_level: 2 });
    const c1 = entry('c1', { dag_parent_id: 'sum1' });
    const out = substituteDagSummaries([summary, c1], { minChildren: 2 });
    const ids = out.map((r) => r.entry.id);
    expect(ids).toContain('sum1');
    expect(ids).toContain('c1');
  });

  it('keeps children whose summary parent is NOT present', () => {
    const c1 = entry('c1', { dag_parent_id: 'absent' });
    const c2 = entry('c2', { dag_parent_id: 'absent' });
    const out = substituteDagSummaries([c1, c2], { minChildren: 2 });
    expect(out.map((r) => r.entry.id).sort()).toEqual(['c1', 'c2']);
  });

  it('is a no-op when there are no summaries (baseline conditions)', () => {
    const a = entry('a');
    const b = entry('b');
    const input = [a, b];
    const out = substituteDagSummaries(input, { minChildren: 2 });
    expect(out).toEqual(input);
  });

  it('is pure: does not mutate the input array', () => {
    const summary = entry('sum1', { dag_level: 2 });
    const c1 = entry('c1', { dag_parent_id: 'sum1' });
    const c2 = entry('c2', { dag_parent_id: 'sum1' });
    const input = [summary, c1, c2];
    const snapshot = input.map((r) => r.entry.id);
    substituteDagSummaries(input, { minChildren: 2 });
    expect(input.map((r) => r.entry.id)).toEqual(snapshot);
  });

  it('is deterministic across repeated calls', () => {
    const summary = entry('sum1', { dag_level: 2 });
    const c1 = entry('c1', { dag_parent_id: 'sum1' });
    const c2 = entry('c2', { dag_parent_id: 'sum1' });
    const lone = entry('lone');
    const input = [summary, c1, c2, lone];
    const a = substituteDagSummaries(input, { minChildren: 2 }).map((r) => r.entry.id);
    const b = substituteDagSummaries(input, { minChildren: 2 }).map((r) => r.entry.id);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// (d) Tombstone: rebuild drops a superseded child, includes its successor
// ---------------------------------------------------------------------------

describe('tombstone (supersession-aware rebuild)', () => {
  it('rebuilt merge summary omits the superseded child token, includes the successor token, drillDown omits the stale child', async () => {
    // Build a merge cluster of 3 related members that share a common filler
    // (so textOverlap >= 0.35 and they merge) but each adds a DISTINCT clause,
    // so ONLY member A carries the STALE token. Superseding A then uniquely
    // removes STALE. (If all three carried STALE, dropping one would not remove
    // the token — a deliberate distinct-carrier design.)
    const STALE = 'ANS_STALE_111';
    const CUR = 'ANS_CUR_222';
    const SHARED = 'Cygnus pricing tier subscription bracket competitor telemetry'; // 6 shared tokens
    const e1 = createMemory(`${SHARED} primary headline price ${STALE}.`, { layer: Layer.Episodic });
    const e2 = createMemory(`${SHARED} secondary annual contract addendum.`, { layer: Layer.Episodic });
    const e3 = createMemory(`${SHARED} tertiary regional rollout note.`, { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);
    writeEntry(tmpDir, e3);

    await consolidate(tmpDir, { now: new Date() });
    let all = loadAllEntries(tmpDir);
    const summary = all.find((e) => e.tags.includes('dag-summary'));
    expect(summary, 'merge summary must exist').toBeTruthy();
    const summaryId = summary!.id;
    expect(summary!.content, 'summary carries the stale token before supersession').toContain(STALE);
    // sanity: all 3 merged under this summary
    expect(all.filter((e) => e.dag_parent_id === summaryId).length).toBe(3);

    // Supersede child e1 (the sole STALE carrier) with a successor carrying CUR.
    const ctx = ADMIN(tmpDir);
    const sup = supersede(ctx, e1.id, `${SHARED} primary headline price ${CUR}.`);
    expect(sup.ok).toBe(true);

    // Link the successor to the same DAG parent (production supersede does not
    // propagate dag_parent_id; the test wires it so the rebuild input contains
    // the live successor — the mechanism under test is the rebuild dispatch,
    // not supersede's link propagation).
    const successor = readEntry(tmpDir, sup.newId, 'default');
    expect(successor).toBeTruthy();
    writeEntry(tmpDir, { ...successor!, dag_parent_id: summaryId });

    // Supersede marked the parent dirty; rebuild it (key-less => compressor route).
    const reb = await rebuildDirtySummaries(tmpDir, { apiKey: '', cap: 20 });
    expect(reb.rebuilt).toBeGreaterThanOrEqual(1);

    all = loadAllEntries(tmpDir);
    const rebuilt = all.find((e) => e.id === summaryId)!;
    expect(rebuilt.content).not.toContain(STALE); // stale child dropped
    expect(rebuilt.content).toContain(CUR);       // successor included

    // drillDown returns live children only (superseded e1 excluded by the
    // archived/superseded-aware child loader is NOT guaranteed; assert e1's
    // stale token is not surfaced as a live child while the successor is).
    const dd = drillDown(ctx, summaryId, { limit: 50 });
    expect('failure' in dd).toBe(false);
    if (!('failure' in dd)) {
      const childContents = dd.children.map((c) => c.content).join('\n');
      expect(childContents).toContain(CUR);
      // e1 itself is superseded; it must not be presented as a live answer.
      const e1StillChild = dd.children.some((c) => c.id === e1.id);
      expect(e1StillChild, 'superseded child A must not appear in drillDown').toBe(false);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// (e) physicsSearch budget pack demotes children when the summary is packed
// ---------------------------------------------------------------------------

describe('physicsSearch budget substitution', () => {
  it('demotes >=2 children at a fixed budget when their summary is in the candidate set', async () => {
    // Build a merge cluster -> real L2 summary node + linked children. The merge
    // pass uses textOverlap (no embeddings), so this works without the model.
    const ANS = 'ANS9090';
    const members = [
      `Hydra incident owner is ${ANS}. response ownership rotated per weekend escalation roster.`,
      `Hydra incident owner equals ${ANS}. response ownership rotated per weekend escalation roster.`,
      `Hydra incident owner namely ${ANS}. response ownership rotated per weekend escalation roster.`,
    ];
    for (const c of members) writeEntry(tmpDir, createMemory(c, { layer: Layer.Episodic, source: 'lse-test' }));
    await consolidate(tmpDir, {});
    const entries = loadAllEntries(tmpDir);
    const summary = entries.find((e) => e.tags.includes('dag-summary'))!;
    expect(summary).toBeTruthy();
    const childIds = entries.filter((e) => e.dag_parent_id === summary.id).map((e) => e.id);
    expect(childIds.length).toBe(3);

    // Seed SYNTHETIC physics particles (4-dim, perfect cosine match to the query
    // vector) for the summary AND all children so physicsSearch takes the
    // physics path deterministically — independent of the local embedding model
    // (which does not load in every CI worker). Same approach as
    // tests/dag-recall-first-class.test.ts.
    const queryEmbedding = [1, 0, 0, 0];
    const mkParticle = (id: string): PhysicsParticle => ({
      memoryId: id,
      position: [1, 0, 0, 0],
      velocity: [0, 0, 0, 0],
      mass: 1.0,
      charge: 0,
      temperature: 0.5,
      lastSimulation: new Date().toISOString(),
    });
    const db = openHippoDb(tmpDir);
    try {
      savePhysicsState(db, [summary.id, ...childIds].map(mkParticle));
    } finally {
      db.close();
    }

    const opts = {
      hippoRoot: tmpDir, physicsConfig: PC, budget: 2000, minResults: 1,
      summaryFreshness: false, summaryDeboost: 1.0, queryEmbedding,
    } as const;

    // CONTROL — substitution OFF: the children are NOT demoted from the pack.
    const offRes = await physicsSearch('Hydra incident owner', entries, {
      ...opts, substituteSummaryChildren: false,
    });
    const offIds = new Set(offRes.map((r) => r.entry.id));
    const childrenInOff = childIds.filter((id) => offIds.has(id));
    // mechanism precondition: the summary AND >=2 of its children all compete in
    // the same pack (else substitution is vacuous and the test proves nothing).
    expect(offIds.has(summary.id), 'summary must be a candidate').toBe(true);
    expect(childrenInOff.length, 'control: >=2 children present without substitution').toBeGreaterThanOrEqual(2);

    // SUBSTITUTION ON (explicit opt-in; the library DEFAULT is now OFF because
    // substitution was measured to regress budget-QA -6.3pp): the summary
    // substitutes for its present children — every child present in the OFF
    // pack is dropped, summary kept.
    const onRes = await physicsSearch('Hydra incident owner', entries, {
      ...opts, substituteSummaryChildren: true,
    });
    const onIds = new Set(onRes.map((r) => r.entry.id));
    expect(onIds.has(summary.id), 'summary kept under substitution').toBe(true);
    for (const cid of childrenInOff) {
      expect(onIds.has(cid), `child ${cid} demoted by substitution`).toBe(false);
    }
    // the answer token is still present (carried by the substituting summary)
    expect(onRes.some((r) => r.entry.content.includes(ANS))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// codex review fixes (P1 idempotency, P2 read-time tombstone)
// ---------------------------------------------------------------------------

describe('codex review fixes', () => {
  it('P1: repeated consolidation is idempotent (does not re-merge already-parented children)', async () => {
    const e1 = createMemory('Kestrel launch slot is ANS1212 schedule frozen after readiness review board', { layer: Layer.Episodic });
    const e2 = createMemory('Kestrel launch slot namely ANS1212 schedule frozen after readiness review board', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);

    await consolidate(tmpDir, { now: new Date() });
    let all = loadAllEntries(tmpDir);
    let summaries = all.filter((e) => e.tags.includes('dag-summary'));
    expect(summaries.length).toBe(1);
    const firstSummaryId = summaries[0].id;
    expect(summaries[0].descendant_count).toBe(2);

    // Second sleep: children are now dag_parent_id-linked, so they MUST be
    // excluded from mergeCandidates - no new summary, no orphan, no re-link.
    await consolidate(tmpDir, { now: new Date() });
    all = loadAllEntries(tmpDir);
    summaries = all.filter((e) => e.tags.includes('dag-summary'));
    expect(summaries.length, 'no second summary created').toBe(1);
    expect(summaries[0].id, 'same summary preserved').toBe(firstSummaryId);
    expect(summaries[0].descendant_count, 'descendant_count intact').toBe(2);
    const children = all.filter((e) => e.dag_parent_id === firstSummaryId && e.layer === Layer.Episodic);
    expect(children.length, 'children still linked to the original summary').toBe(2);
  });

  it('P2: drillDown excludes a superseded child at read time (before any rebuild)', async () => {
    const e1 = createMemory('Merlin owner is ANS_OLD_77 ownership rotated weekend escalation roster duty', { layer: Layer.Episodic });
    const e2 = createMemory('Merlin owner equals ANS_OLD_77 ownership rotated weekend escalation roster duty', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);
    await consolidate(tmpDir, { now: new Date() });
    const summary = loadAllEntries(tmpDir).find((e) => e.tags.includes('dag-summary'))!;
    expect(summary).toBeTruthy();

    const ctx = ADMIN(tmpDir);
    const sup = supersede(ctx, e1.id, 'Merlin owner is ANS_NEW_88 ownership rotated weekend escalation roster duty');
    expect(sup.ok).toBe(true);

    // NO rebuild here. drillDown must NOT surface the superseded child e1.
    const dd = drillDown(ctx, summary.id, { limit: 50 });
    expect('failure' in dd).toBe(false);
    if (!('failure' in dd)) {
      expect(dd.children.some((c) => c.id === e1.id), 'superseded child hidden at read time').toBe(false);
    }
  });

  it('P2-a: compressor preserves DISTINCT value tokens that share a template', () => {
    // Same template, different value+topic tokens -> NOT paraphrases under
    // set-equality, so BOTH must survive. A fuzzy 0.7 Jaccard would have wrongly
    // dropped the second as a near-duplicate (codex P2-a).
    const out = compressContents([
      'Quarterly revenue figure is ANS_Q1_5M after the audit close review cycle',
      'Quarterly revenue figure is ANS_Q2_7M after the audit close review cycle',
    ]);
    expect(out).toContain('ANS_Q1_5M');
    expect(out).toContain('ANS_Q2_7M');
  });

  it('P2-b: a superseded child stays detached after a full consolidate (no pendingWrites clobber)', async () => {
    const e1 = createMemory('Phoenix release date is ANS_D1_0303 milestone fixed at planning summit review', { layer: Layer.Episodic });
    const e2 = createMemory('Phoenix release date equals ANS_D1_0303 milestone fixed at planning summit review', { layer: Layer.Episodic });
    writeEntry(tmpDir, e1);
    writeEntry(tmpDir, e2);
    await consolidate(tmpDir, { now: new Date() });
    const ctx = ADMIN(tmpDir);
    const sup = supersede(ctx, e1.id, 'Phoenix release date is ANS_D2_0404 milestone fixed at planning summit review');
    expect(sup.ok).toBe(true);

    // Full consolidate: rebuildDirtySummaries detaches the superseded child;
    // the pendingWrites drop must keep that detach DURABLE (the decay-pass copy
    // must not re-link it under the parent).
    await consolidate(tmpDir, { now: new Date() });
    const e1After = readEntry(tmpDir, e1.id, 'default');
    expect(e1After, 'superseded child still present').toBeTruthy();
    expect(e1After!.dag_parent_id, 'superseded child detached durably').toBeNull();
  });
});
