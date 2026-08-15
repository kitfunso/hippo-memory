/**
 * LC2-E3 — memory-value decay-pass wiring tests
 * (docs/plans/2026-08-10-lc2-e3-mv-wiring.md, task T4).
 *
 * Real scratch stores throughout (house rule). FILE-UNIQUE scratch root:
 * parallel vitest workers collide on a SHARED root (hard-learned — see
 * tests/memory-value-fit.test.ts's FIT_SCRATCH_ROOT comment), so this file
 * gets its own uniquely-named root, distinct from every other harness test
 * file's root name.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

import { consolidate } from '../src/consolidate.js';
import {
  initStore,
  writeEntry,
  loadAllEntries,
  listMemoryConflicts,
  loadSessionDecayContext,
  batchWriteAndDelete,
} from '../src/store.js';
import { createMemory, Layer, calculateStrength, type MemoryEntry, type DecayOptions } from '../src/memory.js';
import { loadConfig } from '../src/config.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import {
  computeMvFeatures,
  MV_FEATURE_NAMES,
  scoreEntries,
  rescueSet,
  rankNonPinnedByTenant,
  validateWeights,
} from '../src/memory-value.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from '../src/memory-value-weights.js';

// @ts-expect-error - .mjs harness modules have no type declarations
import { computeFeatures } from '../benchmarks/memory-value/extract.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// File-unique scratch root (see file header comment).
const SCRATCH_ROOT = path.join(os.tmpdir(), 'hippo-mv-wiring-test-scratch');
fs.mkdirSync(SCRATCH_ROOT, { recursive: true });

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'case-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

/** Fixed clock for every test in this file — removes real-wall-clock drift
 *  from age_days-sensitive scoring assertions. */
const NOW = new Date('2026-08-10T12:00:00.000Z');
function ancientDate(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function enableMemoryValue(hippoRoot: string, extra: Record<string, unknown> = {}): void {
  const configPath = path.join(hippoRoot, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ memoryValue: { enabled: true }, physics: { enabled: false }, ...extra }, null, 2),
  );
}

/** A condemned-by-construction entry: ancient + half_life_days=1 pushes
 *  clock-basis AND any DecayOptions-basis strength to ~0 regardless of the
 *  configured decayBasis. Only `content` (and therefore content_length,
 *  the largest-magnitude live weight) varies by default across callers that
 *  hold every other field constant — see the rank-determinism comment in
 *  describe('(e) rescue semantics'). */
function condemnedEntry(
  content: string,
  opts: { layer?: Layer; tenantId?: string; tags?: string[]; confidence?: MemoryEntry['confidence'] } = {},
): MemoryEntry {
  const created = ancientDate(3650);
  const base = createMemory(content, {
    layer: opts.layer ?? Layer.Semantic,
    tenantId: opts.tenantId,
    tags: opts.tags,
    confidence: opts.confidence,
  });
  const overridden: MemoryEntry = {
    ...base,
    created,
    last_retrieved: created,
    valid_from: created,
    half_life_days: 1,
    retrieval_count: 0,
    outcome_positive: 0,
    outcome_negative: 0,
    pinned: false,
  };
  // T5 fix (AT1 in-suite flake): single-source the stored `strength` to the
  // same frozen clock basis as every other field above, instead of trusting
  // createMemory's own computed value. createMemory (memory.ts:539) derives
  // its initial strength via calculateStrength(entry) with NO explicit
  // `now`, which defaults to a SECOND, separate evalNow() call -- distinct
  // from the one that stamped created/last_retrieved a few lines earlier
  // (memory.ts:494). Any real clock tick between those two reads makes
  // daysSince a tiny positive epsilon instead of exactly 0, so `base.strength`
  // can land at 0.999999999... instead of 1.0 (confirmed empirically: ~0.1%
  // of calls landed non-unity in a 200k-iteration stress repro -- rare in
  // isolation, likelier under full-suite worker contention, matching the
  // observed isolation-pass/suite-fail split). Re-deriving here against
  // `created` itself as `now` makes daysSince exactly 0 by definition
  // (last_retrieved === created above): strength is exactly 1.0 with zero
  // dependency on the real clock.
  return { ...overridden, strength: calculateStrength(overridden, new Date(created)) };
}

function auditRescueRows(hippoRoot: string, tenantId: string) {
  const db = openHippoDb(hippoRoot);
  try {
    return queryAuditEvents(db, { tenantId, op: 'mv_rescue' });
  } finally {
    closeHippoDb(db);
  }
}

// ---------------------------------------------------------------------------
// (a) feature parity vs benchmarks/memory-value/extract.mjs
// ---------------------------------------------------------------------------
describe('(a) feature parity vs extract.mjs computeFeatures', () => {
  it('computeMvFeatures matches the benchmark for all 8 shared dims on real store-round-tripped entries', () => {
    initStore(dir);
    const built: MemoryEntry[] = [
      createMemory('alpha short note about a topic', { layer: Layer.Episodic }),
      {
        ...createMemory(
          'a much longer memory entry with considerably more words describing something in detail',
          { layer: Layer.Semantic },
        ),
        retrieval_count: 7,
        outcome_positive: 3,
        outcome_negative: 1,
      },
      {
        ...createMemory('bravo second memory entry', { layer: Layer.Trace }),
        retrieval_count: 0,
        outcome_positive: 0,
        outcome_negative: 5,
        half_life_days: 21,
      },
      {
        ...createMemory('charlie a pinned rule that never decays', { pinned: true }),
        retrieval_count: 2,
      },
      {
        ...createMemory('delta an ancient entry', { layer: Layer.Buffer }),
        created: ancientDate(400),
        last_retrieved: ancientDate(200),
        half_life_days: 3,
      },
    ];
    for (const e of built) writeEntry(dir, e);
    const loaded = loadAllEntries(dir);
    expect(loaded.length).toBe(built.length);

    for (const entry of loaded) {
      const mv = computeMvFeatures(entry, NOW);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bench = computeFeatures(entry, NOW) as any;
      for (const f of MV_FEATURE_NAMES) {
        expect(mv[f]).toBeCloseTo(bench[f], 10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (b) normalization parity vs evaluate.mjs min-max
// ---------------------------------------------------------------------------
describe('(b) normalization parity vs evaluate.mjs min-max', () => {
  it('scoreEntries matches an independently-computed min-max normalization + weighted dot product', () => {
    initStore(dir);
    const built: MemoryEntry[] = [
      createMemory('one', { layer: Layer.Semantic }),
      createMemory('two two', { layer: Layer.Semantic }),
      createMemory('three three three words here', { layer: Layer.Semantic }),
      createMemory('four four four four word entry with extra padding text', { layer: Layer.Semantic }),
      createMemory(
        'five five five five five word entry with even more extra padding text added here',
        { layer: Layer.Semantic },
      ),
    ].map((e, i) => ({
      ...e,
      retrieval_count: i,
      outcome_positive: i % 2,
      outcome_negative: (i + 1) % 3,
      half_life_days: 7 + i,
    }));
    for (const e of built) writeEntry(dir, e);
    const loaded = loadAllEntries(dir);

    const raw = new Map(loaded.map((e) => [e.id, computeMvFeatures(e, NOW)]));
    const minMax: Record<string, { min: number; max: number }> = {};
    for (const f of MV_FEATURE_NAMES) {
      let min = Infinity;
      let max = -Infinity;
      for (const e of loaded) {
        const v = raw.get(e.id)![f];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      minMax[f] = { min, max };
    }
    // evaluate.mjs's own formula (benchmarks/memory-value/evaluate.mjs:213-216).
    const norm = (f: string, v: number): number => {
      const { min, max } = minMax[f];
      return max === min ? 0 : (v - min) / (max - min);
    };
    const expected = new Map<string, number>();
    for (const e of loaded) {
      const nf = raw.get(e.id)!;
      let sum = 0;
      for (const f of MV_FEATURE_NAMES) sum += MEMORY_VALUE_WEIGHTS[f] * norm(f, nf[f]);
      expected.set(e.id, sum);
    }

    const actual = scoreEntries(loaded, NOW);
    for (const e of loaded) {
      expect(actual.get(e.id)!).toBeCloseTo(expected.get(e.id)!, 10);
    }
  });

  it('a feature constant across the entry set normalizes to 0 (matches evaluate.mjs semantics)', () => {
    initStore(dir);
    // Identical created/last_retrieved/half_life/outcome/retrieval fields ->
    // every dim except content_length is constant across the set, so it is
    // the ONLY nonzero contribution (weight -0.615, negative -> shorter wins).
    const built: MemoryEntry[] = [
      condemnedEntry('short'),
      condemnedEntry('a somewhat longer piece of content here'),
      condemnedEntry(
        'an even longer piece of content with quite a few more words in it than the others',
      ),
    ];
    for (const e of built) writeEntry(dir, e);
    const loaded = loadAllEntries(dir);
    const scores = scoreEntries(loaded, NOW);

    const sortedByLength = [...loaded].sort((a, b) => a.content.length - b.content.length);
    for (let i = 0; i < sortedByLength.length - 1; i++) {
      expect(scores.get(sortedByLength[i].id)!).toBeGreaterThan(scores.get(sortedByLength[i + 1].id)!);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) weights-sync: constant equals the committed JSON artifact
// ---------------------------------------------------------------------------
describe('(c) weights-sync vs the committed JSON artifact', () => {
  it('MEMORY_VALUE_WEIGHTS matches weights-learned.json values exactly; digest matches the meta sidecar', () => {
    const weightsJsonPath = path.join(repoRoot, 'benchmarks', 'memory-value', 'weights-learned.json');
    const metaJsonPath = path.join(repoRoot, 'benchmarks', 'memory-value', 'weights-learned.meta.json');
    const artifactWeights = JSON.parse(fs.readFileSync(weightsJsonPath, 'utf8')) as Record<string, number>;
    const meta = JSON.parse(fs.readFileSync(metaJsonPath, 'utf8')) as { weightsFileSha256: string };

    expect(Object.keys(MEMORY_VALUE_WEIGHTS).sort()).toEqual(Object.keys(artifactWeights).sort());
    expect(Object.keys(MEMORY_VALUE_WEIGHTS).sort()).toEqual([...MV_FEATURE_NAMES].sort());
    for (const key of Object.keys(artifactWeights)) {
      expect(MEMORY_VALUE_WEIGHTS[key]).toBe(artifactWeights[key]);
    }
    expect(SOURCE_ARTIFACT_SHA256).toBe(meta.weightsFileSha256);
  });
});

// ---------------------------------------------------------------------------
// (d) flag-off byte-identical
// ---------------------------------------------------------------------------
describe('(d) flag-off byte-identical', () => {
  it('identical survivor/removed sets and zero mv audit rows with memoryValue.enabled false (default)', async () => {
    initStore(dir);
    // DEFAULT_CONFIG.memoryValue.enabled === false; no config.json override.
    const fresh = createMemory('a perfectly healthy fresh memory entry', { layer: Layer.Semantic });
    const ancient = condemnedEntry('an old memory that should decay away in the usual way');
    const pinned = { ...createMemory('a pinned rule', { pinned: true }), created: ancientDate(3650), last_retrieved: ancientDate(3650), half_life_days: 1 };
    for (const e of [fresh, ancient, pinned]) writeEntry(dir, e);

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(1);
    expect(result.details.some((l) => l.includes('🛟'))).toBe(false);

    const remaining = loadAllEntries(dir);
    expect(remaining.find((e) => e.id === fresh.id)).toBeDefined();
    expect(remaining.find((e) => e.id === pinned.id)).toBeDefined();
    expect(remaining.find((e) => e.id === ancient.id)).toBeUndefined();

    expect(auditRescueRows(dir, 'default').length).toBe(0);
  });

  it('bigger mixed store (~40 entries, pinned/condemned/healthy, 3 tenants): survivor set, counts, and full details match a predicate-computed expectation', async () => {
    initStore(dir);
    // Disable the other decay-adjacent passes so result.details is
    // decay-pass-only and directly comparable to the predicate below
    // (review-round F8 wants the FULL details array checked, not just
    // counts). memoryValue stays unset -> DEFAULT_CONFIG's false.
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ replay: { count: 0 }, physics: { enabled: false }, autoTraceCapture: false }, null, 2),
    );

    const tenants = ['d-t1', 'd-t2', 'd-t3'];
    const built: MemoryEntry[] = [];
    for (const tenantId of tenants) {
      for (let i = 0; i < 10; i++) {
        built.push(createMemory(`${tenantId} healthy entry ${i} with distinct padding text`, {
          layer: Layer.Semantic,
          tenantId,
        }));
      }
      for (let i = 0; i < 3; i++) {
        built.push(condemnedEntry(`${tenantId} condemned entry ${i}`, { tenantId }));
      }
      built.push({
        ...createMemory(`${tenantId} pinned rule`, { pinned: true, layer: Layer.Semantic, tenantId }),
        created: ancientDate(3650),
        last_retrieved: ancientDate(3650),
        half_life_days: 1,
      });
    }
    expect(built.length).toBeGreaterThanOrEqual(40); // 3 tenants * (10 + 3 + 1) = 42

    for (const e of built) writeEntry(dir, e);

    // Predicate expectation, computed from the SAME order consolidate()
    // will load (loadAllEntries's `ORDER BY created ASC, id ASC`) -- NOT
    // `built`'s construction order, since entries sharing an identical
    // `created` value (all healthy entries created within the same test
    // tick; all condemned/pinned entries sharing the identical
    // ancientDate(3650) string) tie-break on id, not insertion order.
    const loadedBeforeSleep = loadAllEntries(dir);
    const config = loadConfig(dir);
    const sessionCtx = loadSessionDecayContext(dir);
    const decayOpts: DecayOptions = {
      decayBasis: config.decayBasis,
      avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
      sleepCount: sessionCtx.sleepCount,
    };
    const expectedRemovedIds = new Set<string>();
    const expectedSurvivorIds = new Set<string>();
    const expectedRemovedDetails: string[] = [];
    for (const entry of loadedBeforeSleep) {
      const strength = calculateStrength(entry, NOW, decayOpts);
      if (!entry.pinned && strength < 0.05) {
        expectedRemovedIds.add(entry.id);
        expectedRemovedDetails.push(`  🗑  removed ${entry.id} (strength ${strength.toFixed(4)} < 0.05)`);
      } else {
        expectedSurvivorIds.add(entry.id);
      }
    }
    expect(expectedRemovedIds.size).toBe(9); // 3 tenants * 3 condemned each
    expect(expectedSurvivorIds.size).toBe(built.length - 9);

    const result = await consolidate(dir, { now: NOW });

    expect(result.removed).toBe(expectedRemovedIds.size);
    expect(result.decayed).toBe(expectedSurvivorIds.size);
    expect(result.details.some((l) => l.includes('🛟'))).toBe(false);
    // Full details array: with replay/physics/autoTraceCapture off and no
    // Episodic/conflicting content, decay's removed lines are the entirety
    // of result.details, in loadAllEntries order.
    expect(result.details).toEqual(expectedRemovedDetails);

    const remainingIds = new Set(loadAllEntries(dir).map((e) => e.id));
    expect(remainingIds).toEqual(expectedSurvivorIds);
    for (const id of expectedRemovedIds) expect(remainingIds.has(id)).toBe(false);

    for (const tenantId of tenants) {
      expect(auditRescueRows(dir, tenantId).length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) rescue semantics
// ---------------------------------------------------------------------------
describe('(e) rescue semantics', () => {
  it('rescue/delete split by learned rank; deletes-subset property; audit rows carry rank context', async () => {
    initStore(dir);
    enableMemoryValue(dir);

    // 10 condemned entries, one tenant, every dim identical except
    // content_length (10..100 chars) -> ranking is purely by content_length
    // ascending (see condemnedEntry's doc comment). keepN = ceil(0.3*10) = 3,
    // so the 3 shortest are rescued and the 7 longest are deleted.
    const lens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const built = lens.map((len) => condemnedEntry('w'.repeat(len), { tenantId: 'ta' }));
    for (const e of built) writeEntry(dir, e);

    const sortedByLen = [...built].sort((a, b) => a.content.length - b.content.length);
    const expectedRescued = new Set(sortedByLen.slice(0, 3).map((e) => e.id));
    const expectedDeleted = new Set(sortedByLen.slice(3).map((e) => e.id));

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(7);

    const remainingIds = new Set(loadAllEntries(dir).map((e) => e.id));
    for (const id of expectedRescued) expect(remainingIds.has(id)).toBe(true);
    for (const id of expectedDeleted) expect(remainingIds.has(id)).toBe(false);

    const events = auditRescueRows(dir, 'ta');
    expect(events.length).toBe(3);
    expect(new Set(events.map((e) => e.targetId))).toEqual(expectedRescued);
    for (const ev of events) {
      const meta = ev.metadata as { rank?: number; totalNonPinned?: number; keepN?: number; score?: number };
      expect(meta.totalNonPinned).toBe(10);
      expect(meta.keepN).toBe(3);
      expect(meta.rank).toBeGreaterThanOrEqual(1);
      expect(meta.rank!).toBeLessThanOrEqual(3);
      expect(typeof meta.score).toBe('number');
    }
  });

  it('rescued entries get the standard survivor bookkeeping refresh (stored strength + confidence), not left stale', async () => {
    initStore(dir);
    enableMemoryValue(dir);

    // 10 condemned entries (>= MIN_RESCUE_GROUP -- review-round F1's
    // small-tenant floor), confidence 'observed' (createMemory's 'verified'
    // default never changes via resolveConfidence regardless of age, so it
    // can't demonstrate the confidence half of the refresh). content_length
    // spread (10..100) -> keepN = ceil(0.3*10) = 3 rescues the 3 shortest;
    // we only assert on the top 2 (a safe subset of the top 3 regardless of
    // exactly which entry takes rank 3).
    const lens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const built = lens.map((len) =>
      condemnedEntry('w'.repeat(len), { tenantId: 'te', confidence: 'observed' }),
    );
    for (const e of built) writeEntry(dir, e);

    const sortedByLen = [...built].sort((a, b) => a.content.length - b.content.length);
    const rescuedSrc = sortedByLen.slice(0, 2);
    expect(rescuedSrc.every((e) => e.strength === 1.0 && e.confidence === 'observed')).toBe(true);

    await consolidate(dir, { now: NOW });

    const after = loadAllEntries(dir);
    for (const orig of rescuedSrc) {
      const refreshed = after.find((e) => e.id === orig.id);
      expect(refreshed, `expected rescued entry ${orig.id} to survive`).toBeDefined();
      // P2-1 fix: rescued entries get the SAME bookkeeping refresh as every
      // other survivor -- stored strength reflects the actual computed
      // (condemnation-basis) strength, not the stale original (1.0 default
      // from createMemory).
      expect(refreshed!.strength).toBeLessThan(0.05); // DECAY_THRESHOLD
      expect(refreshed!.strength).not.toBe(orig.strength);
      // Effective confidence is refreshed too (observed -> stale after 3650
      // ancient days via resolveConfidence), not left at the original value.
      expect(refreshed!.confidence).toBe('stale');
      // D1 still holds: no half-life edits, no rank-derived writes.
      expect(refreshed!.half_life_days).toBe(orig.half_life_days);
    }
  });

  it('rescued entries participate in the same cycle\'s merge pass', async () => {
    initStore(dir);
    enableMemoryValue(dir);

    // 2 identical-content "twin" episodic entries (textOverlap = 1.0, well
    // above MERGE_OVERLAP_THRESHOLD) + 1 short harmless filler + 7 long
    // filler entries. All condemned; keepN = ceil(0.3*10) = 3 rescues the 2
    // twins + the short filler (all three shorter than every long filler).
    const twinContent = 'shared duplicate memory content twin marker';
    const twinA = condemnedEntry(twinContent, { layer: Layer.Episodic, tenantId: 'tb' });
    const twinB = condemnedEntry(twinContent, { layer: Layer.Episodic, tenantId: 'tb' });
    const shortFiller = condemnedEntry('unrelated short filler', { tenantId: 'tb' });
    const longFillers = Array.from({ length: 7 }, (_, i) =>
      condemnedEntry(`padding filler entry number ${i} ${'q'.repeat(120)}`, { tenantId: 'tb' }),
    );
    const built = [twinA, twinB, shortFiller, ...longFillers];
    for (const e of built) writeEntry(dir, e);

    const result = await consolidate(dir, { now: NOW });
    expect(result.merged).toBeGreaterThanOrEqual(2);

    const after = loadAllEntries(dir);
    const semanticSummary = after.find(
      (e) => e.layer === Layer.Semantic && e.content.startsWith('[Consolidated'),
    );
    expect(semanticSummary, 'expected a new merged semantic summary').toBeDefined();

    // Both rescued twins survive (demoted half-life, not deleted).
    expect(after.find((e) => e.id === twinA.id)).toBeDefined();
    expect(after.find((e) => e.id === twinB.id)).toBeDefined();
  });

  it('rescued entries participate in conflict detection (rescuedIds bypasses the strength filter)', async () => {
    initStore(dir);
    enableMemoryValue(dir);

    // 2 short conflicting-polarity Buffer entries + 8 longer, unrelated
    // Semantic filler entries (>= MIN_RESCUE_GROUP total -- review-round
    // F1's small-tenant floor). All condemned; keepN = ceil(0.3*10) = 3, and
    // the 2 conflicting entries are both far shorter than every filler, so
    // both land inside the top 3 regardless of which filler takes rank 3 --
    // assert both are rescued (a superset check), not an exact rescued set.
    // Buffer layer: excluded from the merge pass (Episodic-only), included
    // in detectConflicts (only Semantic is excluded there) — keeps this
    // sub-test isolated from the merge-pass sub-test above.
    const a = condemnedEntry(
      'widget caching is enabled by default for every request',
      { layer: Layer.Buffer, tenantId: 'tc' },
    );
    const b = condemnedEntry(
      'widget caching is disabled by default for every request',
      { layer: Layer.Buffer, tenantId: 'tc' },
    );
    const fillers = Array.from({ length: 8 }, (_, i) =>
      condemnedEntry(`completely unrelated filler content block number ${i} ${'z'.repeat(100 + i * 10)}`, {
        layer: Layer.Semantic,
        tenantId: 'tc',
      }),
    );
    for (const e of [a, b, ...fillers]) writeEntry(dir, e);

    const events = auditRescueRows(dir, 'tc');
    expect(events.length).toBe(0); // sanity: nothing audited before sleep runs

    await consolidate(dir, { now: NOW });

    const rescuedTargets = new Set(auditRescueRows(dir, 'tc').map((e) => e.targetId));
    expect(rescuedTargets.has(a.id)).toBe(true);
    expect(rescuedTargets.has(b.id)).toBe(true);

    const conflicts = listMemoryConflicts(dir, 'open', 'tc');
    const found = conflicts.find(
      (c) =>
        (c.memory_a_id === a.id && c.memory_b_id === b.id) ||
        (c.memory_a_id === b.id && c.memory_b_id === a.id),
    );
    expect(found, 'expected a conflict row between the two rescued entries').toBeDefined();
    expect(found!.reason).toMatch(/enabled\/disabled/);
  });

  it('tenants smaller than MIN_RESCUE_GROUP never rescue (small-tenant degeneracy floor, review-round F1)', async () => {
    initStore(dir);
    enableMemoryValue(dir);

    // A condemned-only 1-entry tenant: without the floor, ceil(0.3*1) = 1
    // guarantees an immortal rescue every single sleep. With
    // MIN_RESCUE_GROUP = 10, this tenant's non-pinned candidate set (1) is
    // below the floor -> keepN 0 -> no rescue, flag-on behaves exactly like
    // flag-off for this tenant.
    const lonely = condemnedEntry('a lonely condemned memory with no tenant-mates', { tenantId: 'tf' });
    writeEntry(dir, lonely);

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(1);
    expect(result.details.some((l) => l.includes('🛟'))).toBe(false);

    const remaining = loadAllEntries(dir);
    expect(remaining.find((e) => e.id === lonely.id)).toBeUndefined();
    expect(auditRescueRows(dir, 'tf').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (f) pinned exemption unchanged
// ---------------------------------------------------------------------------
describe('(f) pinned exemption unchanged', () => {
  it('a pinned, ancient entry survives with the flag on and is never rescued/audited', async () => {
    initStore(dir);
    enableMemoryValue(dir);

    const entry = {
      ...createMemory('permanent pinned rule that must never decay', { pinned: true }),
      created: ancientDate(3650),
      last_retrieved: ancientDate(3650),
      half_life_days: 1,
    };
    writeEntry(dir, entry);

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(0);

    const remaining = loadAllEntries(dir);
    expect(remaining.find((e) => e.id === entry.id)).toBeDefined();
    expect(auditRescueRows(dir, 'default').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (g) fail-loud: corrupted weights constant
// ---------------------------------------------------------------------------
describe('(g) fail-loud on a malformed weights constant', () => {
  it('validateWeights throws on a non-finite weight value', () => {
    const bad = { ...MEMORY_VALUE_WEIGHTS, age_days: Number.NaN };
    expect(() => validateWeights(bad, SOURCE_ARTIFACT_SHA256)).toThrow(/not a finite number/);
  });

  it('validateWeights throws on a missing dim', () => {
    const missingDim = { ...MEMORY_VALUE_WEIGHTS };
    delete (missingDim as Record<string, number>).content_length;
    expect(() => validateWeights(missingDim, SOURCE_ARTIFACT_SHA256)).toThrow(/not a finite number/);
  });

  it('validateWeights throws when the digest is missing', () => {
    expect(() => validateWeights(MEMORY_VALUE_WEIGHTS, '')).toThrow(/digest missing/);
  });

  it('rescueSet propagates the throw at its own top — flag-on + a broken constant never behaves as flag-off', () => {
    initStore(dir);
    // >= MIN_RESCUE_GROUP non-pinned entries in the tenant (review-round F1)
    // so this exercises the eligible-for-rescue path, even though the
    // assertions below only care about the throw, not the rescue outcome.
    const condemned = condemnedEntry('an entry that would otherwise be condemned and evaluated');
    writeEntry(dir, condemned);
    for (let i = 0; i < 9; i++) writeEntry(dir, condemnedEntry(`filler tenant-mate ${i}`));
    const all = loadAllEntries(dir);
    const badWeights = { ...MEMORY_VALUE_WEIGHTS, strength: Number.POSITIVE_INFINITY };

    expect(() => rescueSet(all, new Set([condemned.id]), NOW, badWeights, SOURCE_ARTIFACT_SHA256)).toThrow(
      /not a finite number/,
    );
    // Sanity: the real frozen constant is valid — the throw above is
    // specific to the corrupted override, not a false-positive on the
    // production path.
    expect(() => rescueSet(all, new Set([condemned.id]), NOW)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (h) scale characterization (~2,000 entries, 3 tenants)
// ---------------------------------------------------------------------------
describe('(h) scale characterization', () => {
  it('deterministic, deletes-subset, per-tenant isolation at ~2,000 entries / 3 tenants; reports rescue rate', async () => {
    // mulberry32 — deterministic PRNG so the fixture itself is reproducible.
    function mulberry32(seed: number): () => number {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = mulberry32(20260810);
    const wordBank = [
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa',
      'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon',
      'phi', 'chi', 'psi', 'omega', 'quartz', 'ember', 'lattice', 'marble', 'cobalt', 'willow',
      'harbor', 'meadow', 'crimson', 'granite', 'velvet', 'canyon', 'thistle', 'ripple', 'signal', 'anchor',
    ];
    const TENANTS = ['scale-t1', 'scale-t2', 'scale-t3'];
    const N_PER_TENANT = 700;
    const CONDEMNED_FRACTION = 0.15;

    function buildEntries(): MemoryEntry[] {
      const out: MemoryEntry[] = [];
      for (const tenantId of TENANTS) {
        for (let i = 0; i < N_PER_TENANT; i++) {
          const isCondemned = rand() < CONDEMNED_FRACTION;
          const wordCount = 3 + Math.floor(rand() * 20);
          const words: string[] = [];
          for (let w = 0; w < wordCount; w++) words.push(wordBank[Math.floor(rand() * wordBank.length)]);
          const content = `${tenantId} entry ${i}: ${words.join(' ')}`;
          // 95% non-Episodic so the merge pass's O(N^2) episodic-candidate
          // scan and detectConflicts's O(N^2) non-Semantic scan both stay
          // small regardless of total N (plan's Risks section / T4(h) note).
          // Tenant A (TENANTS[0]) is EXCLUDED from Episodic entirely
          // (review-round F11): the merge pass demotes a merged episodic's
          // half_life_days WITHIN the same cycle, which would perturb
          // tenant A's own per-tenant min-max normalization context between
          // cycle 1 and cycle 2 -- a real, orthogonal same-tenant effect
          // that would confound the cross-tenant isolation property F11
          // checks (tenant B's mutation must not move tenant A's rescue
          // outcomes; a tenant-A-internal merge moving them is a different
          // question this test isn't asking).
          const layerRoll = rand();
          const layer = tenantId === TENANTS[0]
            ? (layerRoll < 0.6 ? Layer.Semantic : layerRoll < 0.85 ? Layer.Trace : Layer.Buffer)
            : layerRoll < 0.9 ? Layer.Semantic
            : layerRoll < 0.95 ? Layer.Trace
            : layerRoll < 0.98 ? Layer.Buffer
            : Layer.Episodic;
          const retrieval_count = Math.floor(rand() * 10);
          const outcome_positive = Math.floor(rand() * 5);
          const outcome_negative = Math.floor(rand() * 5);
          const ageDays = isCondemned ? 200 + Math.floor(rand() * 3000) : Math.floor(rand() * 5);
          const half_life_days = isCondemned ? 1 : 7 + Math.floor(rand() * 20);
          const created = new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();
          out.push({
            ...createMemory(content, { layer, tenantId }),
            created,
            last_retrieved: created,
            half_life_days,
            retrieval_count,
            outcome_positive,
            outcome_negative,
            pinned: false,
          });
        }
      }
      return out;
    }

    const entries = buildEntries();
    expect(entries.length).toBeGreaterThanOrEqual(2000);

    initStore(dir);
    enableMemoryValue(dir, { replay: { count: 0 }, autoTraceCapture: false });
    batchWriteAndDelete(dir, entries, []);

    const loaded = loadAllEntries(dir);
    expect(loaded.length).toBe(entries.length);

    const config = loadConfig(dir);
    const sessionCtx = loadSessionDecayContext(dir);
    const decayOpts: DecayOptions = {
      decayBasis: config.decayBasis,
      avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
      sleepCount: sessionCtx.sleepCount,
    };
    const condemnedIds = new Set(
      loaded.filter((e) => !e.pinned && calculateStrength(e, NOW, decayOpts) < 0.05).map((e) => e.id),
    );
    expect(condemnedIds.size).toBeGreaterThan(0);

    // --- Determinism ---
    const rescued1 = rescueSet(loaded, condemnedIds, NOW);
    const rescued2 = rescueSet(loaded, condemnedIds, NOW);
    expect([...rescued2].sort()).toEqual([...rescued1].sort());

    // --- Deletes-subset property ---
    for (const id of rescued1) expect(condemnedIds.has(id)).toBe(true);

    // --- Per-tenant isolation: mutate tenant B's composition, tenant A's
    // rescue outcomes for its condemned entries must be unchanged. ---
    const tenantAId = TENANTS[0];
    const tenantBId = TENANTS[1];
    const tenantBIds = new Set(loaded.filter((e) => e.tenantId === tenantBId).map((e) => e.id));
    const dropCount = Math.floor(tenantBIds.size * 0.4);
    let dropped = 0;
    const mutated = loaded.filter((e) => {
      if (e.tenantId === tenantBId && dropped < dropCount) {
        dropped++;
        return false;
      }
      return true;
    });
    expect(dropped).toBeGreaterThan(0);

    const rescuedAfterMutation = rescueSet(mutated, condemnedIds, NOW);
    const tenantACondemned = [...condemnedIds].filter((id) => {
      const e = loaded.find((x) => x.id === id);
      return e?.tenantId === tenantAId;
    });
    expect(tenantACondemned.length).toBeGreaterThan(0);
    for (const id of tenantACondemned) {
      expect(rescuedAfterMutation.has(id)).toBe(rescued1.has(id));
    }

    // --- Rescue rate (characterized, not gated) ---
    const rescueRate = rescued1.size / condemnedIds.size;
    const perTenant: Record<string, { condemned: number; rescued: number }> = {};
    for (const tenantId of TENANTS) {
      const tCondemned = [...condemnedIds].filter((id) => loaded.find((x) => x.id === id)?.tenantId === tenantId);
      const tRescued = tCondemned.filter((id) => rescued1.has(id));
      perTenant[tenantId] = { condemned: tCondemned.length, rescued: tRescued.length };
    }
    console.log('[T4(h) scale characterization] rescue rate:', {
      totalCondemned: condemnedIds.size,
      totalRescued: rescued1.size,
      rescueRate,
      perTenant,
    });

    // --- End-to-end cross-check: the real consolidate() pipeline's actual
    // decisions must match the pure-function prediction above. ---
    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(condemnedIds.size - rescued1.size);
    const finalIds = new Set(loadAllEntries(dir).map((e) => e.id));
    for (const id of condemnedIds) {
      expect(finalIds.has(id)).toBe(rescued1.has(id));
    }

    // --- Review-round F11: G4 isolation proven through the FULL wiring,
    // not just the pure rescueSet function. A SECOND, SEPARATE store,
    // seeded with the IDENTICAL initial composition but with tenant B's
    // rows mutated in the REAL STORE before its own (single) consolidate()
    // run, must produce IDENTICAL tenant-A mv_rescue audit rows to the
    // first store's cycle above (same ids, same rank/totalNonPinned/keepN/
    // score). Two SEPARATE one-cycle stores, not two sequential cycles on
    // the same store: a second cycle on the SAME store starts from a
    // tenant-A composition already shrunk by the first cycle's own
    // deletions (a real, expected, but orthogonal effect — not an
    // isolation break) that would confound a same-store before/after
    // comparison. Holding tenant A's starting composition fixed across two
    // stores isolates exactly the property under test: tenant B's
    // composition, and nothing else, is what may differ.
    type MvAuditMeta = { rank?: number; totalNonPinned?: number; keepN?: number; score?: number };
    const cycle1Events = auditRescueRows(dir, tenantAId);
    const cycle1ByIdMeta = new Map(
      cycle1Events
        .filter((e) => e.targetId !== null)
        .map((e) => [e.targetId as string, e.metadata as MvAuditMeta]),
    );
    expect(cycle1ByIdMeta.size).toBeGreaterThan(0);

    const dirMutated = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'case-'));
    try {
      initStore(dirMutated);
      enableMemoryValue(dirMutated, { replay: { count: 0 }, autoTraceCapture: false });

      const tenantBIds = new Set(loaded.filter((e) => e.tenantId === tenantBId).map((e) => e.id));
      const dropCount = Math.floor(tenantBIds.size * 0.4);
      expect(dropCount).toBeGreaterThan(0);
      let droppedForMutated = 0;
      const seedForMutated = loaded.filter((e) => {
        if (e.tenantId === tenantBId && droppedForMutated < dropCount) {
          droppedForMutated++;
          return false;
        }
        return true;
      });
      batchWriteAndDelete(dirMutated, seedForMutated, []);

      await consolidate(dirMutated, { now: NOW });

      const mutatedEvents = auditRescueRows(dirMutated, tenantAId);
      const mutatedByIdMeta = new Map(
        mutatedEvents
          .filter((e) => e.targetId !== null)
          .map((e) => [e.targetId as string, e.metadata as MvAuditMeta]),
      );

      expect([...mutatedByIdMeta.keys()].sort()).toEqual([...cycle1ByIdMeta.keys()].sort());
      for (const [id, meta1] of cycle1ByIdMeta) {
        const meta2 = mutatedByIdMeta.get(id);
        expect(meta2, `tenant A rescue metadata missing in the tenant-B-mutated store for ${id}`).toBeDefined();
        expect(meta2!.rank).toBe(meta1.rank);
        expect(meta2!.totalNonPinned).toBe(meta1.totalNonPinned);
        expect(meta2!.keepN).toBe(meta1.keepN);
        expect(meta2!.score).toBe(meta1.score);
      }
    } finally {
      fs.rmSync(dirMutated, { recursive: true, force: true });
    }
  }, 60_000);
});

/** Parses entry ids out of decay-pass detail lines (review-round F7: parity
 *  by IDS, not just counts). Line shapes (src/consolidate.ts):
 *    "  🛟 <id> (strength ...) - rescued (...)"
 *    "  🗑  removed <id> (strength ...)"
 */
function parseRescuedIds(details: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of details) {
    const m = line.match(/🛟\s+(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}
function parseRemovedIds(details: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of details) {
    const m = line.match(/🗑\s+removed\s+(\S+)/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// (i) dry-run parity
// ---------------------------------------------------------------------------
describe('(i) dry-run parity', () => {
  it('dry-run preview decisions match a real run on a cloned store', async () => {
    const dirDry = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'case-'));
    const dirReal = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'case-'));
    try {
      initStore(dirDry);
      initStore(dirReal);
      enableMemoryValue(dirDry);
      enableMemoryValue(dirReal);

      const lens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const built = lens.map((len) => condemnedEntry('w'.repeat(len), { tenantId: 'ti' }));
      for (const e of built) {
        writeEntry(dirDry, e);
        writeEntry(dirReal, e); // identical ids in both stores — a true clone
      }

      const sortedByLen = [...built].sort((a, b) => a.content.length - b.content.length);
      const expectedRescued = new Set(sortedByLen.slice(0, 3).map((e) => e.id));
      const expectedDeleted = new Set(sortedByLen.slice(3).map((e) => e.id));

      const dryResult = await consolidate(dirDry, { dryRun: true, now: NOW });
      const realResult = await consolidate(dirReal, { now: NOW });

      expect(dryResult.dryRun).toBe(true);
      expect(dryResult.removed).toBe(realResult.removed);
      expect(dryResult.decayed).toBe(realResult.decayed);
      expect(dryResult.removed).toBe(expectedDeleted.size);

      // F7: parity by IDS, not just counts — parse the rescued/removed
      // entry ids out of both runs' details and assert set equality.
      const dryRescuedIds = parseRescuedIds(dryResult.details);
      const realRescuedIds = parseRescuedIds(realResult.details);
      expect(dryRescuedIds).toEqual(realRescuedIds);
      expect(dryRescuedIds).toEqual(expectedRescued);

      const dryRemovedIds = parseRemovedIds(dryResult.details);
      const realRemovedIds = parseRemovedIds(realResult.details);
      expect(dryRemovedIds).toEqual(realRemovedIds);
      expect(dryRemovedIds).toEqual(expectedDeleted);

      // Dry-run: store untouched, zero audit rows.
      expect(loadAllEntries(dirDry).length).toBe(built.length);
      expect(auditRescueRows(dirDry, 'ti').length).toBe(0);

      // Real run: expected deletes gone, expected rescues present, audit rows match.
      const realIds = new Set(loadAllEntries(dirReal).map((e) => e.id));
      for (const id of expectedRescued) expect(realIds.has(id)).toBe(true);
      for (const id of expectedDeleted) expect(realIds.has(id)).toBe(false);

      const events = auditRescueRows(dirReal, 'ti');
      expect(new Set(events.map((e) => e.targetId))).toEqual(expectedRescued);
    } finally {
      fs.rmSync(dirDry, { recursive: true, force: true });
      fs.rmSync(dirReal, { recursive: true, force: true });
    }
  });
});
