import { describe, it, expect } from 'vitest';
import { consolidate } from '../../src/index.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { calculateStrength, type DecayOptions } from '../../src/entry/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { loadConfig } from '../../src/host/config-file.js';
import { rescueSet } from '../../src/domain/consolidate/memory-value.js';
import { mulberry32 } from '../_helpers/property.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, loadSessionDecayContext, writeEntriesTogether } from '../_helpers/root-forms.js';
import { closeHippoDb, openHippoDb, withWriteScope } from '../../src/db/index.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entries/entry-writes.js';
import { initTestStore } from '../_helpers/store-template.js';
import {
  dir,
  useMemoryValueScratch,
  NOW,
  enableMemoryValue,
  condemnedEntry,
  hasStringTargetId,
  auditRescueRows,
} from '../_helpers/memory-value-wiring.js';
import { detailLines } from '../_helpers/sleep-lines.js';

useMemoryValueScratch();

function seedRows(root: string, rows: readonly MemoryEntry[]): void {
  const db = openHippoDb(root);
  try {
    withWriteScope(db, 'seed_rows', () => rows.forEach((entry) => writeEntryDbOnly(db, entry)));
  } finally {
    closeHippoDb(db);
  }
}

describe('(h) scale characterization', () => {
  it('deterministic, deletes-subset, per-tenant isolation at ~2,000 entries / 3 tenants; reports rescue rate', async () => {
    const rand = mulberry32(20260810);
    const wordBank = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota',
      'kappa',
      'lambda',
      'mu',
      'nu',
      'xi',
      'omicron',
      'pi',
      'rho',
      'sigma',
      'tau',
      'upsilon',
      'phi',
      'chi',
      'psi',
      'omega',
      'quartz',
      'ember',
      'lattice',
      'marble',
      'cobalt',
      'willow',
      'harbor',
      'meadow',
      'crimson',
      'granite',
      'velvet',
      'canyon',
      'thistle',
      'ripple',
      'signal',
      'anchor',
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
          const layerRoll = rand();
          const layer =
            tenantId === TENANTS[0]
              ? layerRoll < 0.6
                ? Layer.Semantic
                : layerRoll < 0.85
                  ? Layer.Trace
                  : Layer.Buffer
              : layerRoll < 0.9
                ? Layer.Semantic
                : layerRoll < 0.95
                  ? Layer.Trace
                  : layerRoll < 0.98
                    ? Layer.Buffer
                    : Layer.Episodic;
          const retrievalCount = Math.floor(rand() * 10);
          const outcomePositive = Math.floor(rand() * 5);
          const outcomeNegative = Math.floor(rand() * 5);
          const ageDays = isCondemned ? 200 + Math.floor(rand() * 3000) : Math.floor(rand() * 5);
          const halfLifeDays = isCondemned ? 1 : 7 + Math.floor(rand() * 20);
          const created = new Date(NOW.getTime() - ageDays * 24 * 60 * 60 * 1000).toISOString();
          out.push({
            ...createMemory(content, { layer, tenantId }),
            created,
            lastRetrieved: created,
            halfLifeDays,
            retrievalCount,
            outcomePositive,
            outcomeNegative,
            pinned: false,
          });
        }
      }
      return out;
    }

    const entries = buildEntries();
    expect(entries).toHaveLength(TENANTS.length * N_PER_TENANT);

    initTestStore(dir);
    enableMemoryValue(dir, { replay: { count: 0 }, autoTraceCapture: false });
    seedRows(dir, entries);

    const loaded = loadEveryTenantEntries(dir);
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
    expect(condemnedIds.size).toBe(327);

    const rescued1 = rescueSet(loaded, condemnedIds, NOW);
    const rescued2 = rescueSet(loaded, condemnedIds, NOW);
    expect([...rescued2].sort()).toEqual([...rescued1].sort());

    for (const id of rescued1) expect(condemnedIds.has(id)).toBe(true);

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
    expect(dropped).toBe(280);

    const rescuedAfterMutation = rescueSet(mutated, condemnedIds, NOW);
    const tenantACondemned = [...condemnedIds].filter((id) => {
      const e = loaded.find((x) => x.id === id);
      return e?.tenantId === tenantAId;
    });
    expect(tenantACondemned).toHaveLength(106);
    for (const id of tenantACondemned) {
      expect(rescuedAfterMutation.has(id)).toBe(rescued1.has(id));
    }

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

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(condemnedIds.size - rescued1.size);
    const finalIds = new Set(loadEveryTenantEntries(dir).map((e) => e.id));
    for (const id of condemnedIds) {
      expect(finalIds.has(id)).toBe(rescued1.has(id));
    }

    type MvAuditMeta = { rank?: number; totalNonPinned?: number; keepN?: number; score?: number };
    const cycle1Events = auditRescueRows(dir, tenantAId);
    // SAFETY: consolidate.ts's mv_rescue audit always writes metadata as
    // exactly { rank, totalNonPinned, keepN, score } (consolidate.ts's
    // rescue-audit write site).
    const cycle1ByIdMeta = new Map(
      cycle1Events.filter(hasStringTargetId).map((e) => [e.targetId, e.metadata as MvAuditMeta]),
    );
    expect(cycle1ByIdMeta.size).toBe(perTenant[tenantAId].rescued);
    expect(cycle1ByIdMeta.size).toBeGreaterThan(0);

    const dirMutated = makeRoot('case');
    enableMemoryValue(dirMutated, { replay: { count: 0 }, autoTraceCapture: false });

    expect(dropCount).toBe(280);
    let droppedForMutated = 0;
    const seedForMutated = loaded.filter((e) => {
      if (e.tenantId === tenantBId && droppedForMutated < dropCount) {
        droppedForMutated++;
        return false;
      }
      return true;
    });
    seedRows(dirMutated, seedForMutated);

    await consolidate(dirMutated, { now: NOW });

    const mutatedEvents = auditRescueRows(dirMutated, tenantAId);
    // SAFETY: consolidate.ts's mv_rescue audit always writes metadata as
    // exactly { rank, totalNonPinned, keepN, score } (consolidate.ts's
    // rescue-audit write site).
    const mutatedByIdMeta = new Map(
      mutatedEvents.filter(hasStringTargetId).map((e) => [e.targetId, e.metadata as MvAuditMeta]),
    );

    expect([...mutatedByIdMeta.keys()].sort()).toEqual([...cycle1ByIdMeta.keys()].sort());
    for (const [id, meta1] of cycle1ByIdMeta) {
      const meta2 = mutatedByIdMeta.get(id);
      expect(meta2, `tenant A rescue metadata differs in the tenant-B-mutated store for ${id}`).toEqual(meta1);
      expect(meta2!.rank).toBe(meta1.rank);
      expect(meta2!.totalNonPinned).toBe(meta1.totalNonPinned);
      expect(meta2!.keepN).toBe(meta1.keepN);
      expect(meta2!.score).toBe(meta1.score);
    }
  });
});

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

describe('(i) dry-run parity', () => {
  it('dry-run preview decisions match a real run on a cloned store', async () => {
    const dirDry = makeRoot('case');
    const dirReal = makeRoot('case');
    enableMemoryValue(dirDry);
    enableMemoryValue(dirReal);

    const lens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const built = lens.map((len) => condemnedEntry('w'.repeat(len), { tenantId: 'ti' }));
    writeEntriesTogether(dirDry, built);
    writeEntriesTogether(dirReal, built);

    const sortedByLen = [...built].sort((a, b) => a.content.length - b.content.length);
    const expectedRescued = new Set(sortedByLen.slice(0, 3).map((e) => e.id));
    const expectedDeleted = new Set(sortedByLen.slice(3).map((e) => e.id));

    const dryResult = await consolidate(dirDry, { dryRun: true, now: NOW });
    const realResult = await consolidate(dirReal, { now: NOW });

    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.removed).toBe(realResult.removed);
    expect(dryResult.decayed).toBe(realResult.decayed);
    expect(dryResult.removed).toBe(expectedDeleted.size);

    const dryRescuedIds = parseRescuedIds(detailLines(dryResult));
    const realRescuedIds = parseRescuedIds(detailLines(realResult));
    expect(dryRescuedIds).toEqual(realRescuedIds);
    expect(dryRescuedIds).toEqual(expectedRescued);

    const dryRemovedIds = parseRemovedIds(detailLines(dryResult));
    const realRemovedIds = parseRemovedIds(detailLines(realResult));
    expect(dryRemovedIds).toEqual(realRemovedIds);
    expect(dryRemovedIds).toEqual(expectedDeleted);

    expect(loadEveryTenantEntries(dirDry).length).toBe(built.length);
    expect(auditRescueRows(dirDry, 'ti').length).toBe(0);

    const realIds = new Set(loadEveryTenantEntries(dirReal).map((e) => e.id));
    for (const id of expectedRescued) expect(realIds.has(id)).toBe(true);
    for (const id of expectedDeleted) expect(realIds.has(id)).toBe(false);

    const rescueLines = detailLines(realResult).filter((l) => l.includes('🛟'));
    expect(rescueLines).toHaveLength(3);
    for (const l of rescueLines) expect(l).toMatch(/ - rescued \(rank [123]\/10 in tenant ti, top 3\)$/);

    const events = auditRescueRows(dirReal, 'ti');
    expect(events.length).toBe(3);
    expect(new Set(events.map((e) => e.targetId))).toEqual(expectedRescued);
    for (const ev of events) {
      // SAFETY: consolidate.ts's mv_rescue audit always writes metadata as exactly { rank, totalNonPinned, keepN, score }.
      const meta = ev.metadata as { rank?: number; totalNonPinned?: number; keepN?: number; score?: number };
      expect(meta.totalNonPinned).toBe(10);
      expect(meta.keepN).toBe(3);
      expect(meta.rank).toBeGreaterThanOrEqual(1);
      expect(meta.rank!).toBeLessThanOrEqual(3);
      expect(meta.score).toBeTypeOf('number');
    }
  });
});
