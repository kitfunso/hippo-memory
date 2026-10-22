// Sleep's retired-text check asks the store which held texts each tenant rejected once per tenant per page, so a
// store of many merged rows costs the same few reads as one of a few, and a tenant's rejection still binds only it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemory, Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { loadConfig } from '../../src/host/config-file.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { runConsolidation } from '../../src/domain/consolidate/sleep.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { writeEntriesTogether } from '../_helpers/root-forms.js';

oneRequestPerTest();

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

async function sleepCountingAsks(perTenant: number): Promise<SleepAsks> {
  const { root, acmeMerged } = seeded(perTenant);
  const local = sqliteStore(root);
  const asks: string[] = [];
  const store = {
    ...local,
    consolidation: {
      ...local.consolidation,
      rejectedDigests: (tenantId: string, digests: readonly string[]) => {
        asks.push(tenantId);
        return local.consolidation.rejectedDigests(tenantId, digests);
      },
    },
  };
  const result = await runConsolidation(store, { now: NOW, config: loadConfig(root), tenantId: 'default' });
  const retired = result.details.flatMap((line) => RETIRED.exec(line)?.[1] ?? []);
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
