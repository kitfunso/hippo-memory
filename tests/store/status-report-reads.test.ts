// The status verbs read only the rows their report needs, and the report is the one the whole-store read gave.
import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { buildCorrectionLatency } from '../../src/api/correction-latency.js';
import { buildProvenanceCoverage } from '../../src/api/provenance-coverage.js';
import { physicsEnergyText } from '../../src/cli/status.js';
import type { MemoryEntry } from '../../src/core/memory.js';
import type { PhysicsParticle } from '../../src/core/physics.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, loadAllEntries } from '../_helpers/root-forms.js';

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
  for (let i = 0; i < 30; i++) writeEntry(root, createMemory(`filler memory number ${i}`));
}

describe('status report reads', () => {
  it('builds the same correction-latency report from the narrow read as from every row', () => {
    seed();
    const narrow = sqliteSyncStore(root).reports.correctionEntries();
    expect(narrow.length).toBeLessThan(loadAllEntries(root, 'default').length);
    const report = buildCorrectionLatency(narrow);
    expect(report).toEqual(buildCorrectionLatency(loadAllEntries(root, 'default')));
    expect(report.count).toBe(2);
    expect(report.extractionCount).toBe(1);
  });

  it('builds the same provenance report from the raw rows as from every row', () => {
    seed();
    const report = buildProvenanceCoverage(sqliteSyncStore(root).reports.rawEntries());
    expect(report).toEqual(buildProvenanceCoverage(loadAllEntries(root, 'default')));
    expect(report.rawTotal).toBe(2);
    expect(report.gaps).toHaveLength(1);
  });
});

describe('physicsEnergyText', () => {
  const particles = (n: number): PhysicsParticle[] =>
    Array.from({ length: n }, (_, i) => ({
      memoryId: `m${i}`,
      position: [1, 0],
      velocity: [0, 0],
      mass: 1,
      charge: 0,
      temperature: 1,
      lastSimulation: '2026-01-01T00:00:00.000Z',
    }));

  it('computes the energy at 2000 particles', () => {
    expect(physicsEnergyText(particles(2000), 1)).toMatch(/^energy: -?\d.*\(KE: .*, PE: .*\)$/);
  });

  it('skips the energy above 2000 particles', () => {
    expect(physicsEnergyText(particles(2001), 1)).toBe('energy: skipped (2001 particles)');
  });
});
