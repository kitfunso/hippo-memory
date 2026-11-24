import { describe, it, expect, vi } from 'vitest';
import { consolidate } from '../../src/index.js';
import { Layer } from '../../src/base/memory/entry.js';
import { resolveConfidence } from '../../src/entry/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import {
  mvCandidate,
  rankCandidates,
  rankNonPinnedByTenant,
  rescueSet,
  validateWeights,
} from '../../src/domain/consolidate/memory-value.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from '../../src/domain/consolidate/memory-value-weights.js';
import { loadEveryTenantEntries, listMemoryConflicts } from '../_helpers/root-forms.js';
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
import { detailLines } from '../_helpers/sleep-lines.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry } = sessionPerTest();

useMemoryValueScratch();

describe('(e) rescue semantics', () => {
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

    expect(detailLines(result)).toContain(
      '  ⚠️ memory-value: 1 mv_rescue audit row failed to write (the rescue itself still landed)',
    );
    expect(new Set(auditRescueRows(dir, 'ta').map((e) => e.targetId))).toEqual(new Set([built[0]!.id, built[2]!.id]));
    expect(loadEveryTenantEntries(dir).map((e) => e.id)).toContain(refused);
  });

  it('rescued entries get the standard survivor bookkeeping refresh (stored strength), confidence tier preserved', async () => {
    initTestStore(dir);
    enableMemoryValue(dir);

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
      expect(refreshed!.strength).toBeLessThan(0.05);
      expect(refreshed!.strength).not.toBe(orig.strength);
      expect(refreshed!.confidence).toBe('observed');
      expect(resolveConfidence(refreshed!, NOW)).toBe('stale');
      expect(refreshed!.halfLifeDays).toBe(orig.halfLifeDays);
    }
  });

  it("rescued entries participate in the same cycle's merge pass", async () => {
    initTestStore(dir);
    enableMemoryValue(dir);

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

    expect(after.find((e) => e.id === twinA.id)?.id).toBe(twinA.id);
    expect(after.find((e) => e.id === twinB.id)?.id).toBe(twinB.id);
  });

  it('rescued entries participate in conflict detection (rescuedIds bypasses the strength filter)', async () => {
    initTestStore(dir);
    enableMemoryValue(dir);

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
    expect(events.length).toBe(0);

    await consolidate(dir, { now: NOW });

    const rescuedTargets = new Set(auditRescueRows(dir, 'tc').map((e) => e.targetId));
    expect(rescuedTargets.has(a.id)).toBe(true);
    expect(rescuedTargets.has(b.id)).toBe(true);

    const conflicts = await listMemoryConflicts(dir, 'open', 'tc');
    const found = conflicts.find(
      (c) => (c.memoryAId === a.id && c.memoryBId === b.id) || (c.memoryAId === b.id && c.memoryBId === a.id),
    );
    expect(found!.reason).toMatch(/enabled\/disabled/);
  });

  it('tenants smaller than MIN_RESCUE_GROUP never rescue (small-tenant degeneracy floor)', async () => {
    initTestStore(dir);
    enableMemoryValue(dir);

    const lonely = condemnedEntry('a lonely condemned memory with no tenant-mates', { tenantId: 'tf' });
    writeEntry(dir, lonely);

    const result = await consolidate(dir, { now: NOW });
    expect(result.removed).toBe(1);
    expect(detailLines(result).some((l) => l.includes('🛟'))).toBe(false);

    const remaining = loadEveryTenantEntries(dir);
    expect(remaining.find((e) => e.id === lonely.id)).toBeUndefined();
    expect(auditRescueRows(dir, 'tf').length).toBe(0);
  });

  it('ranks a score tie that differs only by lead-in the same way whole or paged, lead-in order first', async () => {
    const rows = Array.from({ length: 10 }, (_, k) => ({
      ...condemnedEntry('Yes.', { tenantId: 'ta' }),
      id: `row-${9 - k}`,
      leadIn: `lead-${k}`,
    }));
    const condemned = new Set([rows[0]!.id, rows[4]!.id, rows[9]!.id]);
    const candidates = rows.map((row) => mvCandidate(row, NOW, PRODUCTION_STRENGTH));

    const whole = rankNonPinnedByTenant({ entries: rows, now: NOW });
    const paged = await rankCandidates(
      candidates,
      (id) => condemned.has(id),
      (ids) => [rows.filter((row) => ids.includes(row.id))],
    );

    const ranks = (map: typeof whole, ids: Iterable<string>) => [...ids].map((id) => map.get(id)?.rank);
    const everyId = rows.map((row) => row.id);
    expect(ranks(whole, everyId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(ranks(paged, condemned)).toEqual([1, 5, 10]);
  });
});

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

describe('(g) fail-loud on a malformed weights constant', () => {
  it('validateWeights throws on a non-finite weight value', () => {
    const bad = { ...MEMORY_VALUE_WEIGHTS, ageDays: Number.NaN };
    expect(() => validateWeights(bad, SOURCE_ARTIFACT_SHA256)).toThrow(/not a finite number/);
  });

  it('validateWeights throws on a missing dim', () => {
    const missingDim = { ...MEMORY_VALUE_WEIGHTS };
    delete missingDim.contentLength;
    expect(() => validateWeights(missingDim, SOURCE_ARTIFACT_SHA256)).toThrow(/not a finite number/);
  });

  it('validateWeights throws when the digest is missing', () => {
    expect(() => validateWeights(MEMORY_VALUE_WEIGHTS, '')).toThrow(/digest missing/);
  });

  it('rescueSet propagates the throw at its own top — flag-on + a broken constant never behaves as flag-off', () => {
    initTestStore(dir);
    const condemned = condemnedEntry('an entry that would otherwise be condemned and evaluated');
    writeEntry(dir, condemned);
    for (let i = 0; i < 9; i++) writeEntry(dir, condemnedEntry(`filler tenant-mate ${i}`));
    const all = loadEveryTenantEntries(dir);
    const badWeights = { ...MEMORY_VALUE_WEIGHTS, strength: Number.POSITIVE_INFINITY };

    expect(() =>
      rescueSet(all, new Set([condemned.id]), NOW, { weights: badWeights, digest: SOURCE_ARTIFACT_SHA256 }),
    ).toThrow(/not a finite number/);
    expect(() => rescueSet(all, new Set([condemned.id]), NOW)).not.toThrow();
  });
});
