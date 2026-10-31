// The status verbs read only the rows their report needs, and the report is the one the whole-store read gave.
import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { buildCorrectionLatency } from '../../src/api/correction-latency.js';
import { buildProvenanceCoverage } from '../../src/api/provenance-coverage.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, writeEntriesTogether } from '../_helpers/root-forms.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';

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
  it('builds the correction-latency report from the join', async () => {
    seed();
    const report = buildCorrectionLatency(
      (await sqliteStore(root).hippoDb.reports.correctionLinks({ limit: 500 })).links,
    );
    expect(report.count).toBe(2);
    expect(report.extractionCount).toBe(1);
  });

  it('builds the provenance report from the count and the gaps', async () => {
    seed();
    const report = buildProvenanceCoverage(await sqliteStore(root).hippoDb.reports.rawProvenance({ limit: 500 }));
    expect(report.rawTotal).toBe(2);
    expect(report.gaps).toHaveLength(1);
  });

  it('reads the same rows when the store holds five times more rows outside the reports', async () => {
    seed();
    const reports = async () => {
      const { correctionLinks, rawProvenance } = sqliteStore(root).hippoDb.reports;
      return { links: await correctionLinks({ limit: 500 }), raw: await rawProvenance({ limit: 500 }) };
    };
    const before = await recordStatementsAsync(reports);
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
    const after = await recordStatementsAsync(reports);
    expect(after.reads.map((r) => r.rows)).toEqual(before.reads.map((r) => r.rows));
    expect(after.result.raw.total).toBe(22);
    expect(after.result.links).toEqual(before.result.links);
  });
});

describe('status report pages', () => {
  it('walks the links and the gaps one row at a time to the same rows as one big page', async () => {
    seed();
    const { reports } = sqliteStore(root).hippoDb;
    const whole = await reports.correctionLinks({ limit: 500 });
    const links: typeof whole.links = [];
    for (
      let page = await reports.correctionLinks({ limit: 1 });
      ;
      page = await reports.correctionLinks({ limit: 1, after: page.next! })
    ) {
      expect(page.links.length).toBeLessThanOrEqual(1);
      links.push(...page.links);
      if (page.next === null) break;
    }
    expect(links).toEqual(whole.links);
    expect(links).toHaveLength(2);
    const bigGaps = await reports.rawProvenance({ limit: 500 });
    const first = await reports.rawProvenance({ limit: 1 });
    expect(first.total).toBe(bigGaps.total);
    expect([
      ...first.gaps,
      ...(first.next ? (await reports.rawProvenance({ limit: 1, after: first.next })).gaps : []),
    ]).toEqual(bigGaps.gaps);
  });
});
