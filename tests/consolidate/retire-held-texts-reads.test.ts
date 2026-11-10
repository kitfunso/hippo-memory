// Sleep's retired-text check asks the store which held texts each tenant rejected once per tenant per page, so a
// store of many merged rows costs the same few reads as one of a few, and a tenant's rejection still binds only it.
// A dry run asks too, so it names the rows a real sleep retires.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { loadConfig } from '../../src/host/config-file.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { runConsolidation } from '../../src/domain/consolidate/sleep.js';
import type { ConsolidationResult } from '../../src/domain/consolidate/run.js';
import { insertRejectedValue } from '../../src/store/sqlite/review/rejection.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadEveryTenantEntries, writeEntriesTogether } from '../_helpers/root-forms.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { detailLines } from '../_helpers/sleep-lines.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const TENANTS = ['acme', 'default', 'globex'] as const;
const HEADER = '[Consolidated from 3 related memories, newest first]';
const RETIRED = /(\S+) held a retired text/;

beforeEach(() => {
  vi.stubEnv('HIPPO_FAKE_NOW', NOW.toISOString());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const texts = (i: number): string[] => [
  `the ingest queue ${i} drains at night`,
  `the billing export ${i} lands hourly`,
  `the tls rotation ${i} pages oncall`,
];

interface Seeded {
  readonly root: string;
  /** The ids of acme's merged rows, sorted. */
  readonly acmeMerged: string[];
}

interface SleepAsks extends Seeded {
  /** The tenant of each batch tombstone read, sorted. */
  readonly asks: string[];
  /** The ids of the rows the sleep retired a text from, sorted. */
  readonly retired: string[];
}

// Semantic sources, so the merge pass clusters none of them; every tenant holds the same texts.
function seeded(perTenant: number): Seeded {
  const root = makeRoot('retire-held-reads');
  const at = { baseHalfLifeDays: 30, layer: Layer.Semantic };
  const rows: MemoryEntry[] = TENANTS.flatMap((tenantId) =>
    Array.from({ length: perTenant }, (_, i) => {
      const sources = texts(i).map((text) => createMemory(text, { ...at, tenantId }));
      const merged = createMemory(mergedText(HEADER, texts(i)), { ...at, tenantId, source: 'consolidation' });
      return [...sources, { ...merged, parents: sources.map((s) => s.id) }];
    }).flat(),
  );
  writeEntriesTogether(root, rows);
  const acmeMerged = rows.filter((r) => r.tenantId === 'acme' && r.source === 'consolidation').map((r) => r.id);
  const db = openHippoDb(root);
  try {
    // acme alone rejects each row's middle text; default and globex hold the same text and keep it.
    for (let i = 0; i < perTenant; i++) {
      const text = texts(i)[1];
      insertRejectedValue(db, {
        tenantId: 'acme',
        digest: rejectionDigest(text),
        reason: 'test',
        rejectedBy: 'test',
        rejectedAt: NOW.toISOString(),
        normalizedChars: normalizeValueForRejection(text).length,
      });
    }
  } finally {
    closeHippoDb(db);
  }
  return { root, acmeMerged: acmeMerged.sort() };
}

function sleepOn(store: Parameters<typeof runConsolidation>[0], root: string, dryRun = false) {
  return runConsolidation(store, {
    strength: PRODUCTION_STRENGTH,
    now: NOW,
    config: loadConfig(root),
    tenantId: 'default',
    dryRun,
  });
}

async function sleepCountingAsks(perTenant: number): Promise<SleepAsks> {
  const { root, acmeMerged } = seeded(perTenant);
  const local = sqliteStore(root);
  const asks: string[] = [];
  const store = {
    ...local,
    consolidation: {
      ...local.consolidation,
      rejected: (tenantId: string, digests: readonly string[]) => {
        asks.push(tenantId);
        return local.consolidation.rejected(tenantId, digests);
      },
    },
  };
  const result = await sleepOn(store, root);
  const retired = detailLines(result).flatMap((line) => RETIRED.exec(line)?.[1] ?? []);
  return { root, asks: asks.sort(), retired: retired.sort(), acmeMerged };
}

describe("sleep's retired-text check", () => {
  it.each([2, 40])('asks once per tenant over %i merged rows a tenant, and retires only acme rows', async (n) => {
    const { asks, retired, acmeMerged } = await sleepCountingAsks(n);
    expect(asks).toEqual([...TENANTS]);
    expect(retired).toEqual(acmeMerged);
    expect(retired).toHaveLength(n);
  });
});

// The same store twice, one to preview and one to sleep, so each run starts from the same rows.
function copyOf(root: string): string {
  const copy = makeRoot('retire-held-copy');
  cpSync(root, copy, { recursive: true });
  return copy;
}

const retirements = (result: ConsolidationResult) =>
  result.events.flatMap((e) => (e.kind === 'retiredText' ? [{ id: e.id, successorId: e.successorId }] : []));
const rowIds = (root: string): string[] => loadEveryTenantEntries(root).map((e) => e.id);

describe("a dry run's retired-text check", () => {
  it('names the rows a real sleep retires and whether each keeps a successor, and writes nothing', async () => {
    const { root, acmeMerged } = seeded(1);
    const copy = copyOf(root);
    const before = rowIds(root);

    const preview = await sleepOn(sqliteStore(root), root, true);
    const actual = await sleepOn(sqliteStore(copy), copy);

    const named = (result: ConsolidationResult) =>
      retirements(result).map(({ id, successorId }) => [id, successorId !== null]);
    expect(named(actual)).toEqual([[acmeMerged[0], true]]);
    expect(named(preview)).toEqual(named(actual));
    expect(rowIds(root).sort()).toEqual(before.sort());
    // A successor is a new row with a new id, so a preview's names no row.
    expect(rowIds(copy)).toContain(retirements(actual)[0].successorId);
    expect(rowIds(root)).not.toContain(retirements(preview)[0].successorId);
  });

  it('reports the merges a dry run and a real sleep make once a retired text frees its source', async () => {
    const [first, second, third] = texts(0);
    const at = { baseHalfLifeDays: 30, layer: Layer.Episodic };
    const [a, b, c] = [first, second, third].map((text) => createMemory(text, at));
    const lookAlike = createMemory('the billing export 0 lands every hour', at);
    const rollup = createMemory(mergedText(HEADER, texts(0)), {
      ...at,
      layer: Layer.Semantic,
      source: 'consolidation',
    });
    const root = makeRoot('retire-held-frees-source');
    writeEntriesTogether(root, [a, b, c, lookAlike, { ...rollup, parents: [a.id, b.id, c.id] }]);
    const db = openHippoDb(root);
    try {
      insertRejectedValue(db, {
        tenantId: 'default',
        digest: rejectionDigest(second),
        reason: 'test',
        rejectedBy: 'test',
        rejectedAt: NOW.toISOString(),
        normalizedChars: normalizeValueForRejection(second).length,
      });
    } finally {
      closeHippoDb(db);
    }
    const copy = copyOf(root);

    const preview = await sleepOn(sqliteStore(root), root, true);
    const actual = await sleepOn(sqliteStore(copy), copy);

    // A real sleep swaps in the rollup's successor, which frees the rejected text's source to merge with its look-alike;
    // a dry run keeps the old rollup, so its merge count can fall short of the real one.
    console.log(`merged episodic: dry run ${preview.merged}, real sleep ${actual.merged}`);
    expect(retirements(actual).map((r) => r.id)).toEqual([rollup.id]);
    expect(preview.merged).toBeLessThanOrEqual(actual.merged);
  });
});
