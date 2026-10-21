// The status verbs read only the rows their report needs, and the report is the one the whole-store read gave.
import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { buildCorrectionLatency } from '../../src/api/correction-latency.js';
import { buildProvenanceCoverage } from '../../src/api/provenance-coverage.js';
import { physicsEnergyText } from '../../src/surface/cli/status.js';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import type { PhysicsParticle } from '../../src/base/rank/physics.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, writeEntriesTogether, loadAllEntries, loadStoredParticles } from '../_helpers/root-forms.js';
import { vecNorm } from '../../src/base/rank/physics.js';
import { correctionLinksOf, rawProvenanceOf } from '../_helpers/in-memory-reports-store.js';
import { recordStatements } from '../_helpers/count-statements.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let root: string;

beforeEach(() => {
  root = makeRoot('status-reads');
});

function at(entry: MemoryEntry, iso: string): MemoryEntry {
  entry.created = iso;
  entry.validFrom = iso;
  entry.lastRetrieved = iso;
  return entry;
}

function seed(): void {
  const raw = at(
    createMemory('slack: tier moved to 120', { kind: 'raw', owner: 'user:keith', artifactRef: 'slack://a/1' }),
    '2026-04-01T10:00:00.000Z',
  );
  const rawGap = at(createMemory('slack: owner and ref missing', { kind: 'raw' }), '2026-04-01T11:00:00.000Z');
  const oldFact = at(createMemory('belief: tier is 100'), '2026-03-15T00:00:00.000Z');
  const newFact = at(createMemory('belief: tier is 120', { extractedFrom: raw.id }), '2026-04-01T10:30:00.000Z');
  oldFact.supersededBy = newFact.id;
  const oldManual = at(createMemory('belief: seats are 5'), '2026-03-16T00:00:00.000Z');
  const newManual = at(createMemory('belief: seats are 6'), '2026-04-02T00:00:00.000Z');
  oldManual.supersededBy = newManual.id;
  const dangling = at(createMemory('belief: replaced by a deleted row'), '2026-03-17T00:00:00.000Z');
  dangling.supersededBy = 'mem_gone';
  const lone = at(createMemory('belief: never corrected'), '2026-03-18T00:00:00.000Z');
  for (const e of [raw, rawGap, oldFact, newFact, oldManual, newManual, dangling, lone]) writeEntry(root, e);
  writeEntriesTogether(
    root,
    Array.from({ length: 30 }, (_, i) => createMemory(`filler memory number ${i}`)),
  );
}

describe('status report reads', () => {
  it('builds the same correction-latency report from the join as from every row', () => {
    seed();
    const report = buildCorrectionLatency(sqliteSyncStore(root).reports.correctionLinks());
    expect(report).toEqual(buildCorrectionLatency(correctionLinksOf(loadAllEntries(root, 'default'))));
    expect(report.count).toBe(2);
    expect(report.extractionCount).toBe(1);
  });

  it('builds the same provenance report from the count and the gaps as from every row', () => {
    seed();
    const report = buildProvenanceCoverage(sqliteSyncStore(root).reports.rawProvenance());
    expect(report).toEqual(buildProvenanceCoverage(rawProvenanceOf(loadAllEntries(root, 'default'))));
    expect(report.rawTotal).toBe(2);
    expect(report.gaps).toHaveLength(1);
  });

  it('reads the same rows when the store holds five times more rows outside the reports', () => {
    seed();
    const reports = () => {
      const { correctionLinks, rawProvenance } = sqliteSyncStore(root).reports;
      return { links: correctionLinks(), raw: rawProvenance() };
    };
    const before = recordStatements(reports);
    writeEntriesTogether(
      root,
      Array.from({ length: 200 }, (_, i) => createMemory(`more filler memory ${i}`)),
    );
    writeEntriesTogether(
      root,
      Array.from({ length: 20 }, (_, i) =>
        createMemory(`raw receipt ${i}`, { kind: 'raw', owner: 'o', artifactRef: 'r' }),
      ),
    );
    const after = recordStatements(reports);
    expect(after.reads.map((r) => r.rows)).toEqual(before.reads.map((r) => r.rows));
    expect(after.result.raw.total).toBe(22);
    expect(after.result.links).toEqual(before.result.links);
  });
});

describe('physics status stats', () => {
  const particles = (ids: readonly string[]): PhysicsParticle[] =>
    ids.map((memoryId, i) => ({
      memoryId,
      position: [1, 0],
      velocity: [i * 0.5, 0.25],
      mass: 1,
      charge: 0,
      temperature: 1,
      lastSimulation: '2026-01-01T00:00:00.000Z',
    }));

  function seedParticles(n: number): PhysicsParticle[] {
    const entries = Array.from({ length: n }, (_, i) => createMemory(`particle memory ${i}`));
    writeEntriesTogether(root, entries);
    const saved = particles(entries.map((e) => e.id));
    sqliteSyncStore(root).consolidation.saveParticles(saved);
    return saved;
  }

  it('averages the speeds a whole read averages, and loads the particles only up to the limit', () => {
    seedParticles(3);
    const index = sqliteSyncStore(root).embeddingIndex;
    const whole = loadStoredParticles(root);
    const mean = whole.reduce((sum, p) => sum + vecNorm(p.velocity), 0) / whole.length;
    expect(index.particleStats(3)).toEqual({ count: 3, meanSpeed: mean, particles: whole });
    expect(index.particleStats(2)).toEqual({ count: 3, meanSpeed: mean, particles: null });
  });

  it('reads one column past the limit, whatever the particle count', () => {
    seedParticles(4);
    const stats = () => sqliteSyncStore(root).embeddingIndex.particleStats(2);
    const reads = recordStatements(stats).reads.filter((r) => r.sql.includes('memory_physics'));
    expect(reads.map((r) => r.sql)).toEqual(['SELECT velocity_blob FROM memory_physics ORDER BY rowid']);
  });

  it('prints the energy for loaded particles and skips it past the limit', () => {
    expect(physicsEnergyText({ count: 2, particles: particles(['a', 'b']) }, 1)).toMatch(
      /^energy: -?\d.*\(KE: .*, PE: .*\)$/,
    );
    expect(physicsEnergyText({ count: 2001, particles: null }, 1)).toBe('energy: skipped (2001 particles)');
  });
});
