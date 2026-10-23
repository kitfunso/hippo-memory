/**
 * LC2-E3 — memory-value decay-pass wiring tests
 * (docs/plans/2026-08-10-lc2-e3-mv-wiring.md, task T4).
 *
 * Real scratch stores throughout (house rule). FILE-UNIQUE scratch root:
 * parallel vitest workers collide on a SHARED root (hard-learned — see
 * tests/benchmarks/memory-value-fit.process.test.ts's FIT_SCRATCH_ROOT comment), so this file
 * gets its own uniquely-named root, distinct from every other harness test
 * file's root name.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { consolidate } from '../../src/index.js';
import {
  Layer,
  calculateStrength,
  strengthOptionsOf,
  type MemoryEntry,
  type DecayOptions,
} from '../../src/base/memory/memory.js';
import { toWire } from '../../src/base/memory/memory-wire.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { loadConfig } from '../../src/host/config-file.js';
import { withSharedStoreHandles } from '../../src/db/index.js';
import { mvCandidate, scoreEntries, type MvFeatureVector } from '../../src/domain/consolidate/memory-value.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from '../../src/domain/consolidate/memory-value-weights.js';
import { computeFeatures } from '../../benchmarks/memory-value/extract.mjs';
import { loadEveryTenantEntries, loadSessionDecayContext, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  createMemory7,
  repoRoot,
  dir,
  useMemoryValueScratch,
  NOW,
  ancientDate,
  condemnedEntry,
  auditRescueRows,
} from '../_helpers/memory-value-wiring.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

useMemoryValueScratch();

/** The features the decay pass scores an entry by, at the default loss-aversion rules. */
const featuresOf = (entry: MemoryEntry): MvFeatureVector =>
  mvCandidate(entry, NOW, strengthOptionsOf(undefined)).features;
// SAFETY: the frozen weights' keys; test (c) checks they are exactly the scorer's feature keys.
const FEATURE_NAMES = Object.keys(MEMORY_VALUE_WEIGHTS) as ReadonlyArray<keyof MvFeatureVector>;

// ---------------------------------------------------------------------------
// (a) feature parity vs benchmarks/memory-value/extract.mjs
// ---------------------------------------------------------------------------
describe('(a) feature parity vs extract.mjs computeFeatures', () => {
  it('the decay scorer features match the benchmark for all 8 shared dims on real store-round-tripped entries', () => {
    initTestStore(dir);
    const built: MemoryEntry[] = [
      createMemory7('alpha short note about a topic', { layer: Layer.Episodic }),
      {
        ...createMemory('a much longer memory entry with considerably more words describing something in detail', {
          layer: Layer.Semantic,
        }),
        retrievalCount: 7,
        outcomePositive: 3,
        outcomeNegative: 1,
      },
      {
        ...createMemory('bravo second memory entry', { layer: Layer.Trace }),
        retrievalCount: 0,
        outcomePositive: 0,
        outcomeNegative: 5,
        halfLifeDays: 21,
      },
      {
        ...createMemory('charlie a pinned rule that never decays', { pinned: true }),
        retrievalCount: 2,
      },
      {
        ...createMemory('delta an ancient entry', { layer: Layer.Buffer }),
        created: ancientDate(400),
        lastRetrieved: ancientDate(200),
        halfLifeDays: 3,
      },
    ];
    for (const e of built) writeEntry(dir, e);
    const loaded = loadEveryTenantEntries(dir);
    expect(loaded.length).toBe(built.length);

    for (const entry of loaded) {
      const mv = featuresOf(entry);
      // SAFETY: computeFeatures (extract.mjs) computes the same 8-dim
      // feature vector as the scorer; proving that parity is this
      // test's whole point (the loop below checks every FEATURE_NAMES dim).
      const bench = computeFeatures(toWire(entry), NOW) as MvFeatureVector;
      for (const f of FEATURE_NAMES) {
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
    initTestStore(dir);
    const built: MemoryEntry[] = [
      createMemory7('one', { layer: Layer.Semantic }),
      createMemory7('two two', { layer: Layer.Semantic }),
      createMemory7('three three three words here', { layer: Layer.Semantic }),
      createMemory7('four four four four word entry with extra padding text', { layer: Layer.Semantic }),
      createMemory7('five five five five five word entry with even more extra padding text added here', {
        layer: Layer.Semantic,
      }),
    ].map((e, i) => ({
      ...e,
      retrievalCount: i,
      outcomePositive: i % 2,
      outcomeNegative: (i + 1) % 3,
      halfLifeDays: 7 + i,
    }));
    for (const e of built) writeEntry(dir, e);
    const loaded = loadEveryTenantEntries(dir);

    const raw = new Map(loaded.map((e) => [e.id, featuresOf(e)]));
    const minMax: Record<string, { min: number; max: number }> = {};
    for (const f of FEATURE_NAMES) {
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
      for (const f of FEATURE_NAMES) sum += MEMORY_VALUE_WEIGHTS[f] * norm(f, nf[f]);
      expected.set(e.id, sum);
    }

    const actual = scoreEntries(loaded, NOW);
    for (const e of loaded) {
      expect(actual.get(e.id)!).toBeCloseTo(expected.get(e.id)!, 10);
    }
  });

  it('a feature constant across the entry set normalizes to 0 (matches evaluate.mjs semantics)', () => {
    initTestStore(dir);
    // Identical created/last_retrieved/half_life/outcome/retrieval fields ->
    // every dim except content_length is constant across the set, so it is
    // the ONLY nonzero contribution (weight -0.615, negative -> shorter wins).
    const built: MemoryEntry[] = [
      condemnedEntry('short'),
      condemnedEntry('a somewhat longer piece of content here'),
      condemnedEntry('an even longer piece of content with quite a few more words in it than the others'),
    ];
    for (const e of built) writeEntry(dir, e);
    const loaded = loadEveryTenantEntries(dir);
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
    // SAFETY: this repo's own committed benchmark artifact
    // (weights-learned.json), whose shape matches this type.
    const artifactWeights = JSON.parse(fs.readFileSync(weightsJsonPath, 'utf8')) as Record<string, number>;
    // SAFETY: this repo's own committed benchmark artifact
    // (weights-learned.meta.json), whose shape matches this type.
    const meta = JSON.parse(fs.readFileSync(metaJsonPath, 'utf8')) as { weightsFileSha256: string };

    expect(Object.keys(MEMORY_VALUE_WEIGHTS).sort()).toEqual(Object.keys(artifactWeights).sort());
    expect(Object.keys(MEMORY_VALUE_WEIGHTS).sort()).toEqual(
      Object.keys(featuresOf(createMemory7('weights sync probe'))).sort(),
    );
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
  it('bigger mixed store (~40 entries, pinned/condemned/healthy, 3 tenants): survivor set, counts, and full details match a predicate-computed expectation', async () => {
    initTestStore(dir);
    // Disable the other decay-adjacent passes so result.details is
    // decay-pass-only and directly comparable to the predicate below
    // (review-round F8 wants the FULL details array checked, not just
    // counts). memoryValue stays unset -> DEFAULT_CONFIG's false.
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        { replay: { count: 0 }, physics: { enabled: false }, autoTraceCapture: false, dormant: { enabled: false } },
        null,
        2,
      ),
    );

    const tenants = ['d-t1', 'd-t2', 'd-t3'];
    const built: MemoryEntry[] = [];
    for (const tenantId of tenants) {
      for (let i = 0; i < 10; i++) {
        built.push(
          createMemory7(`${tenantId} healthy entry ${i} with distinct padding text`, {
            layer: Layer.Semantic,
            tenantId,
          }),
        );
      }
      for (let i = 0; i < 3; i++) {
        built.push(condemnedEntry(`${tenantId} condemned entry ${i}`, { tenantId }));
      }
      built.push({
        ...createMemory(`${tenantId} pinned rule`, { pinned: true, layer: Layer.Semantic, tenantId }),
        created: ancientDate(3650),
        lastRetrieved: ancientDate(3650),
        halfLifeDays: 1,
      });
    }
    expect(built.length).toBeGreaterThanOrEqual(40); // 3 tenants * (10 + 3 + 1) = 42

    // One connection for the seed loop: a close per write checkpoints the WAL, which is slow on Windows.
    await withSharedStoreHandles(() => {
      for (const e of built) writeEntry(dir, e);
    });

    // Predicate expectation, computed from the SAME order consolidate()
    // will load (loadAllEntries's `ORDER BY created ASC, id ASC`) -- NOT
    // `built`'s construction order, since entries sharing an identical
    // `created` value (all healthy entries created within the same test
    // tick; all condemned/pinned entries sharing the identical
    // ancientDate(3650) string) tie-break on id, not insertion order.
    const loadedBeforeSleep = loadEveryTenantEntries(dir);
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

    const remainingIds = new Set(loadEveryTenantEntries(dir).map((e) => e.id));
    expect(remainingIds).toEqual(expectedSurvivorIds);
    for (const id of expectedRemovedIds) expect(remainingIds.has(id)).toBe(false);

    for (const tenantId of tenants) {
      expect(auditRescueRows(dir, tenantId).length).toBe(0);
    }
  });
});
