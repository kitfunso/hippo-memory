// LC2-E3 memory-value decay-pass wiring: rescue semantics, the pinned exemption and a malformed weights constant.
import { describe, it, expect, vi } from 'vitest';
import { consolidate } from '../../src/index.js';
import { Layer, resolveConfidence } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { rescueSet, validateWeights } from '../../src/domain/consolidate/memory-value.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from '../../src/domain/consolidate/memory-value-weights.js';
import { loadEveryTenantEntries, listMemoryConflicts, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  dir,
  useMemoryValueScratch,
  NOW,
  ancientDate,
  enableMemoryValue,
  condemnedEntry,
  auditRescueRows,
} from '../_helpers/memory-value-wiring.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

useMemoryValueScratch();

// ---------------------------------------------------------------------------
// (e) rescue semantics
// ---------------------------------------------------------------------------
describe('(e) rescue semantics', () => {
  // The rank split, rescue lines and rescue audit metadata are pinned in (i) of the scale file, on the real-run store.
  it('a rescue audit row that fails to write is counted and reported, and the other rows still land', async () => {
    initTestStore(dir);
    enableMemoryValue(dir);
    const built = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((len) =>
      condemnedEntry('w'.repeat(len), { tenantId: 'ta' }),
    );
    for (const e of built) writeEntry(dir, e);
    const refused = built[1]!.id;
    const db = openHippoDb(dir);
    try {
      db.exec(
        `CREATE TRIGGER refuse_one_rescue_audit BEFORE INSERT ON audit_log WHEN NEW.op = 'mv_rescue' AND NEW.target_id = '${refused}' BEGIN SELECT RAISE(ABORT, 'audit row refused'); END`,
      );
    } finally {
      closeHippoDb(db);
    }

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let result: Awaited<ReturnType<typeof consolidate>>;
    try {
      result = await consolidate(dir, { now: NOW });
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('audit write failed'));
    } finally {
      stderr.mockRestore();
    }

    expect(result.details).toContain(
      '  ⚠️ memory-value: 1 mv_rescue audit row failed to write (the rescue itself still landed)',
    );
    expect(new Set(auditRescueRows(dir, 'ta').map((e) => e.targetId))).toEqual(new Set([built[0]!.id, built[2]!.id]));
    expect(loadEveryTenantEntries(dir).map((e) => e.id)).toContain(refused);
  });

  it('rescued entries get the standard survivor bookkeeping refresh (stored strength), confidence tier preserved', async () => {
    initTestStore(dir);
    enableMemoryValue(dir);

    // 10 condemned entries (>= MIN_RESCUE_GROUP -- review-round F1's
    // small-tenant floor), confidence 'observed' (createMemory's 'verified'
    // default never changes via resolveConfidence regardless of age, so it
    // can't demonstrate the confidence half of the refresh). content_length
    // spread (10..100) -> keepN = ceil(0.3*10) = 3 rescues the 3 shortest;
    // we only assert on the top 2 (a safe subset of the top 3 regardless of
    // exactly which entry takes rank 3).
    const lens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const built = lens.map((len) => condemnedEntry('w'.repeat(len), { tenantId: 'te', confidence: 'observed' }));
    for (const e of built) writeEntry(dir, e);

    const sortedByLen = [...built].sort((a, b) => a.content.length - b.content.length);
    const rescuedSrc = sortedByLen.slice(0, 2);
    expect(rescuedSrc.every((e) => e.strength === 1.0 && e.confidence === 'observed')).toBe(true);

    await consolidate(dir, { now: NOW });

    const after = loadEveryTenantEntries(dir);
    for (const orig of rescuedSrc) {
      const refreshed = after.find((e) => e.id === orig.id);
      expect(refreshed?.id, `expected rescued entry ${orig.id} to survive`).toBe(orig.id);
      // P2-1 fix: rescued entries get the SAME bookkeeping refresh as every
      // other survivor -- stored strength reflects the actual computed
      // (condemnation-basis) strength, not the stale original (1.0 default
      // from createMemory).
      expect(refreshed!.strength).toBeLessThan(0.05); // DECAY_THRESHOLD
      expect(refreshed!.strength).not.toBe(orig.strength);
      // Confidence is an epistemic tier, not a cached computation: the store
      // keeps 'observed', while resolveConfidence still reports 'stale'.
      expect(refreshed!.confidence).toBe('observed');
      expect(resolveConfidence(refreshed!, NOW)).toBe('stale');
      // D1 still holds: no half-life edits, no rank-derived writes.
      expect(refreshed!.halfLifeDays).toBe(orig.halfLifeDays);
    }
  });

  it("rescued entries participate in the same cycle's merge pass", async () => {
    initTestStore(dir);
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

    const after = loadEveryTenantEntries(dir);
    const semanticSummary = after.find((e) => e.layer === Layer.Semantic && e.content.startsWith('[Consolidated'));
    expect(semanticSummary?.layer, 'expected a new merged semantic summary').toBe(Layer.Semantic);

    // Both rescued twins survive (demoted half-life, not deleted).
    expect(after.find((e) => e.id === twinA.id)?.id).toBe(twinA.id);
    expect(after.find((e) => e.id === twinB.id)?.id).toBe(twinB.id);
  });

  it('rescued entries participate in conflict detection (rescuedIds bypasses the strength filter)', async () => {
    initTestStore(dir);
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
    const a = condemnedEntry('widget caching is enabled by default for every request', {
      layer: Layer.Buffer,
      tenantId: 'tc',
    });
    const b = condemnedEntry('widget caching is disabled by default for every request', {
      layer: Layer.Buffer,
      tenantId: 'tc',
    });
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

    const conflicts = await listMemoryConflicts(dir, 'open', 'tc');
    const found = conflicts.find(
      (c) => (c.memory_a_id === a.id && c.memory_b_id === b.id) || (c.memory_a_id === b.id && c.memory_b_id === a.id),
    );
    expect(found!.reason).toMatch(/enabled\/disabled/);
  });

  it('tenants smaller than MIN_RESCUE_GROUP never rescue (small-tenant degeneracy floor)', async () => {
    initTestStore(dir);
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

    const remaining = loadEveryTenantEntries(dir);
    expect(remaining.find((e) => e.id === lonely.id)).toBeUndefined();
    expect(auditRescueRows(dir, 'tf').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (f) pinned exemption unchanged
// ---------------------------------------------------------------------------
describe('(f) pinned exemption unchanged', () => {
  it('a pinned, ancient entry survives with the flag on and is never rescued/audited', async () => {
    initTestStore(dir);
    enableMemoryValue(dir);

    const entry = {
      ...createMemory('permanent pinned rule that must never decay', { pinned: true }),
      created: ancientDate(3650),
      lastRetrieved: ancientDate(3650),
      halfLifeDays: 1,
    };
    writeEntry(dir, entry);

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(0);

    const remaining = loadEveryTenantEntries(dir);
    expect(remaining.find((e) => e.id === entry.id)?.id).toBe(entry.id);
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
    delete missingDim.content_length;
    expect(() => validateWeights(missingDim, SOURCE_ARTIFACT_SHA256)).toThrow(/not a finite number/);
  });

  it('validateWeights throws when the digest is missing', () => {
    expect(() => validateWeights(MEMORY_VALUE_WEIGHTS, '')).toThrow(/digest missing/);
  });

  it('rescueSet propagates the throw at its own top — flag-on + a broken constant never behaves as flag-off', () => {
    initTestStore(dir);
    // >= MIN_RESCUE_GROUP non-pinned entries in the tenant (review-round F1)
    // so this exercises the eligible-for-rescue path, even though the
    // assertions below only care about the throw, not the rescue outcome.
    const condemned = condemnedEntry('an entry that would otherwise be condemned and evaluated');
    writeEntry(dir, condemned);
    for (let i = 0; i < 9; i++) writeEntry(dir, condemnedEntry(`filler tenant-mate ${i}`));
    const all = loadEveryTenantEntries(dir);
    const badWeights = { ...MEMORY_VALUE_WEIGHTS, strength: Number.POSITIVE_INFINITY };

    expect(() =>
      rescueSet(all, new Set([condemned.id]), NOW, { weights: badWeights, digest: SOURCE_ARTIFACT_SHA256 }),
    ).toThrow(/not a finite number/);
    // Sanity: the real frozen constant is valid — the throw above is
    // specific to the corrupted override, not a false-positive on the
    // production path.
    expect(() => rescueSet(all, new Set([condemned.id]), NOW)).not.toThrow();
  });
});
