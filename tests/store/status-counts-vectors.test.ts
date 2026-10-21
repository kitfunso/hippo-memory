// `hippo status` counts stored vectors from ids and one blob length; it must never decode a vector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  calculateStrength,
  confidenceFacets,
  createMemory,
  DEFAULT_HALF_LIFE_DAYS,
  Layer,
  type MemoryEntry,
} from '../../src/base/memory/memory.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { recordStatementsAsync } from '../_helpers/count-statements.js';
import { withRequestStoresSync } from '../../src/db/request-stores.js';
import { listMemoryConflicts, writeEntry, updateStats } from '../_helpers/root-forms.js';
import { DAY_MS } from '../../src/base/util/time.js';
import { handleStatus } from '../../src/surface/cli/status.js';
import { runCli } from '../../src/cli.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { makeStore } from '../_helpers/make-root.js';
import {
  loadEveryTenantEntries,
  replaceDetectedConflicts,
  appendConsolidationRun,
  resolveConflictKeeping,
  saveStoredVectors,
  storedVectorSummary,
} from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

type Walk = (this: Float32Array) => IterableIterator<number>;
let home: string;
let root: string;

function liveIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const entry = createMemory(`status vector memory ${i}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(root, entry);
    return entry.id;
  });
}

const NOW = '2026-06-01T00:00:00.000Z';
const daysAgo = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

/** `hippo status` run in this process from `home`, the call bin/hippo.js makes; a non-zero exit fails the test. */
async function status(): Promise<string[]> {
  // No provider key, so the availability line never depends on the machine.
  const env = {
    HIPPO_HOME: path.join(home, 'global'),
    HOME: home,
    USERPROFILE: home,
    HIPPO_FAKE_NOW: NOW,
    OPENAI_API_KEY: '',
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const saved = process.cwd();
  process.chdir(home);
  try {
    const r = await runInProcess(() => runCli(['node', 'hippo', 'status']));
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split(/\r?\n/);
  } finally {
    process.chdir(saved);
  }
}

beforeEach(() => {
  ({ base: home, root } = makeStore('status-vec'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('storedVectorSummary', () => {
  it('counts every vector, orphans included, and returns the dimension', () => {
    const [a, b] = liveIds(2);
    saveStoredVectors(
      root,
      [
        [a, [1, 2, 3, 4]],
        [b, [4, 3, 2, 1]],
        ['orphan', [0, 1, 0, 1]],
      ],
      'm',
    );
    const summary = storedVectorSummary(root);
    expect(summary.vectors).toBe(3);
    expect(summary.dims).toBe(4);
  });

  it('returns no vectors and no dimension on a store without vectors', () => {
    expect(storedVectorSummary(root)).toEqual({ vectors: 0, dims: undefined });
  });
});

describe('hippo status embedding lines', () => {
  it('prints the same embedded count, dimension and orphan note as before', async () => {
    const [a, b] = liveIds(3);
    saveStoredVectors(
      root,
      [
        [a, [1, 2, 3, 4]],
        [b, [4, 3, 2, 1]],
        ['orphan', [0, 1, 0, 1]],
      ],
      'm',
    );
    const lines = (await status()).filter((l) => l.startsWith('Embedded:') || l.includes('model changed'));
    expect(lines).toEqual([
      'Embedded:          2/3 memories (4-dim) (1 orphaned, run `hippo embed` to prune)',
      '                   model changed, run `hippo embed` to reindex',
    ]);
  });

  it('reads no vector element while counting them', async () => {
    const [a, b] = liveIds(2);
    saveStoredVectors(
      root,
      [
        [a, [1, 2, 3, 4]],
        [b, [4, 3, 2, 1]],
      ],
      'm',
    );
    // Array.from over a decoded Float32Array walks this iterator once per vector, so a decode shows as a call.
    // SAFETY: %TypedArray%.prototype always carries Symbol.iterator, whose receiver is a typed array.
    const proto = Object.getPrototypeOf(Float32Array.prototype) as { [Symbol.iterator]: Walk };
    const original = proto[Symbol.iterator];
    let walks = 0;
    proto[Symbol.iterator] = function (this: Float32Array) {
      walks++;
      return original.call(this);
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await handleStatus({ hippoRoot: root, tenantId: 'default', args: [], flags: {} });
    } finally {
      proto[Symbol.iterator] = original;
      log.mockRestore();
    }
    expect(walks).toBe(0);
  });
});

// A provider with no key prints one fixed line, where the local one depends on an optional install.
function useKeylessProvider(): void {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai' } }));
}

let seq = 0;
function row(lastRetrieved: string, fields: Partial<MemoryEntry> = {}): string {
  seq += 1;
  const id = `mem_status${String(seq).padStart(2, '0')}`;
  const base = createMemory(`status row ${seq}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, {
    ...base,
    id,
    created: daysAgo(500 - seq),
    lastRetrieved: lastRetrieved,
    confidence: 'observed',
    ...fields,
  });
  return id;
}

function seedEveryCase(): void {
  withRequestStoresSync(seedEveryCaseIn);
}

function seedEveryCaseIn(): void {
  seq = 0;
  const fresh = row(daysAgo(1), { layer: Layer.Buffer, confidence: 'verified' });
  const aged = row(daysAgo(31));
  row(daysAgo(30), { layer: Layer.Semantic, confidence: 'inferred' });
  row(daysAgo(10), { layer: Layer.Trace, confidence: 'stale', halfLifeDays: 2 });
  row(daysAgo(400), { pinned: true });
  row(daysAgo(1), { layer: Layer.Semantic, confidence: 'verified', pinned: true, outcomeNegative: 3 });
  row('not-a-date', { confidence: 'inferred' });
  // JavaScript reads this date and SQLite's julianday does not, so only a JavaScript tally scores the row.
  row('Wed, 01 Apr 2026 00:00:00 GMT');
  const otherA = row(daysAgo(90), { confidence: 'verified', tenantId: 'other' });
  const otherB = row(daysAgo(20), { layer: Layer.Buffer, halfLifeDays: 1, tenantId: 'other' });
  const boosted = row(daysAgo(2), {
    layer: Layer.Semantic,
    emotionalValence: 'critical',
    retrievalCount: 5,
    outcomePositive: 2,
  });
  row(daysAgo(45), { confidence: 'stale', halfLifeDays: 30, supersededBy: boosted });
  replaceDetectedConflicts(
    root,
    [
      { memory_a_id: fresh, memory_b_id: aged, reason: 'open, one tenant', score: 0.9 },
      { memory_a_id: otherA, memory_b_id: otherB, reason: 'open, the other tenant', score: 0.8 },
      { memory_a_id: fresh, memory_b_id: boosted, reason: 'resolved below', score: 0.7 },
    ],
    NOW,
  );
  const resolved = listMemoryConflicts(root).find((c) => c.reason === 'resolved below');
  if (!resolved) throw new Error('fixture conflict missing');
  if (!resolveConflictKeeping(root, 'default', resolved.id, fresh)) throw new Error('fixture conflict not resolved');
  saveStoredVectors(
    root,
    [
      [fresh, [1, 2, 3, 4]],
      [otherA, [4, 3, 2, 1]],
      ['orphan', [0, 1, 0, 1]],
    ],
    'm',
  );
  updateStats(root, { remembered: 5, recalled: 3, forgotten: 1 });
  appendConsolidationRun(root, { timestamp: daysAgo(2), decayed: 1, merged: 0, removed: 0 });
}

const KEYLESS_LINE = 'Embeddings:        openai configured but OPENAI_API_KEY not set (BM25 only)';

// Arguments follow print order: total and layers; pinned, at risk, conflicts, average; tiers and aged out.
function countLines(layers: string[], health: string[], tiers: string[]): string[] {
  const [total, buffer, episodic, semantic, trace] = layers;
  const [pinned, atRisk, conflicts, average] = health;
  const [verified, observed, inferred, stale, agedOut] = tiers;
  return [
    'Hippo Status',
    '---------------------------',
    `Total memories:    ${total}`,
    `  Buffer:          ${buffer}`,
    `  Episodic:        ${episodic}`,
    `  Semantic:        ${semantic}`,
    `  Trace:           ${trace}`,
    `Pinned:            ${pinned}`,
    `At risk (<0.2):    ${atRisk}`,
    `Open conflicts:    ${conflicts}`,
    `Avg strength:      ${average}`,
    '',
    'Confidence breakdown:',
    `  Verified:        ${verified}`,
    `  Observed:        ${observed}`,
    `  Inferred:        ${inferred}`,
    `  Stale:           ${stale}`,
    `  Aged out:        ${agedOut}  (of the above; excludes pinned, verified)`,
    '',
  ];
}

describe('hippo status full text', () => {
  it('prints every count of a store holding each layer, tier, tenant and date shape', async () => {
    useKeylessProvider();
    seedEveryCase();
    expect(await status()).toEqual([
      ...countLines(['12', '2', '6', '3', '1'], ['2', '4', '2', '0.59'], ['3', '5', '2', '2', '3']),
      'Total remembered:  5',
      'Total recalled:    3',
      'Total forgotten:   1',
      'Last sleep:        2026-05-30T00:00:00.000Z',
      '',
      KEYLESS_LINE,
      'Embedded:          2/12 memories (4-dim) (1 orphaned, run `hippo embed` to prune)',
      '                   model changed, run `hippo embed` to reindex',
      '',
    ]);
  });

  it('prints zeros for an empty store', async () => {
    useKeylessProvider();
    expect(await status()).toEqual([
      ...countLines(['0', '0', '0', '0', '0'], ['0', '0', '0', '0.00'], ['0', '0', '0', '0', '0']),
      'Total remembered:  0',
      'Total recalled:    0',
      'Total forgotten:   0',
      'Last sleep:        never',
      '',
      KEYLESS_LINE,
      '',
    ]);
  });
});

describe('reports.statusCounts', () => {
  it('equals a tally over every loaded entry, to the last bit of the average', () => {
    seedEveryCase();
    // Written weakest first and created strongest first: a sum over rows in any other order than loadAllEntries' ends on other last bits.
    withRequestStoresSync(() => {
      for (let i = 0; i < 40; i++) row(daysAgo(20), { created: daysAgo(900 - i), halfLifeDays: 0.5 * 1.18 ** i });
    });
    const now = new Date(NOW);
    const entries = loadEveryTenantEntries(root);
    const strengths = entries.map((e) => calculateStrength(e, now));
    const counts = sqliteSyncStore(handlesOf(root)).reports.statusCounts(now, 0.2);
    expect(counts.total).toBe(52);
    expect(counts.avgStrength).toBe(strengths.reduce((sum, x) => sum + x, 0) / entries.length);
    expect(counts.atRisk).toBe(strengths.filter((x) => x < 0.2).length);
    expect(counts.agedOut).toBe(entries.filter((e) => confidenceFacets(e, now).agedOut).length);
    expect(counts.pinned).toBe(entries.filter((e) => e.pinned).length);
    expect(counts.byLayer[Layer.Trace]).toBe(entries.filter((e) => e.layer === Layer.Trace).length);
    expect(counts.openConflicts).toBe(listMemoryConflicts(root).length);
    expect(counts.embedded).toBe(2);
  });
});

describe('hippo status read bound', () => {
  it('selects no memory text and no JSON column from the memories table', async () => {
    seedEveryCase();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { statements } = await (async () => {
      try {
        return await recordStatementsAsync(() =>
          handleStatus({ hippoRoot: root, tenantId: 'default', args: [], flags: {} }),
        );
      } finally {
        log.mockRestore();
      }
    })();
    const rowReads = statements.filter((sql) => /^\s*SELECT\b[^;]*\bFROM memories\b/.test(sql));
    // The read count is the code's to change; the one read that walks every row must be among them.
    expect(rowReads).toContain(
      'SELECT layer, confidence, pinned, created, last_retrieved, half_life_days, retrieval_count, ' +
        'emotional_valence, outcome_positive, outcome_negative FROM memories ORDER BY created ASC, id ASC',
    );
    expect(rowReads.filter((sql) => /\b(content|\w+_json)\b/.test(sql))).toEqual([]);
  });
});
