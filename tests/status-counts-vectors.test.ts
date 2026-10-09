// `hippo status` counts stored vectors from ids and one blob length; it must never decode a vector.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { calculateStrength, confidenceFacets, createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../src/core/memory.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadStatusCounts } from '../src/store/candidates.js';
import { recordStatements } from './_helpers/count-statements.js';
import { replaceDetectedConflicts, resolveConflict, listMemoryConflicts } from '../src/store/conflicts.js';
import { appendConsolidationRun, updateStats } from '../src/store/index-and-stats.js';
import { DAY_MS } from '../src/util/time.js';
import { saveStoredVectors, storedVectorSummary } from '../src/store/vector-index.js';
import { handleStatus } from '../src/cli/status.js';

type Walk = (this: Float32Array) => IterableIterator<number>;
const HIPPO_BIN = path.join(process.cwd(), 'bin', 'hippo.js');
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

function status(): string[] {
  // No provider key, so the availability line never depends on the machine.
  const env = { ...process.env, HIPPO_HOME: path.join(home, 'global'), HOME: home, USERPROFILE: home, HIPPO_FAKE_NOW: NOW, OPENAI_API_KEY: undefined };
  return execFileSync('node', [HIPPO_BIN, 'status'], { cwd: home, env, encoding: 'utf-8' }).split(/\r?\n/);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-status-vec-'));
  root = path.join(home, '.hippo');
  initStore(root);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('storedVectorSummary', () => {
  it('returns every vector id, orphans included, and the dimension', () => {
    const [a, b] = liveIds(2);
    saveStoredVectors(root, [[a, [1, 2, 3, 4]], [b, [4, 3, 2, 1]], ['orphan', [0, 1, 0, 1]]], 'm');
    const summary = storedVectorSummary(root);
    expect([...summary.ids].sort()).toEqual([a, b, 'orphan'].sort());
    expect(summary.dims).toBe(4);
  });

  it('returns an empty set and no dimension on a store without vectors', () => {
    expect(storedVectorSummary(root)).toEqual({ ids: new Set(), dims: undefined });
  });
});

describe('hippo status embedding lines', () => {
  it('prints the same embedded count, dimension and orphan note as before', () => {
    const [a, b] = liveIds(3);
    saveStoredVectors(root, [[a, [1, 2, 3, 4]], [b, [4, 3, 2, 1]], ['orphan', [0, 1, 0, 1]]], 'm');
    const lines = status().filter((l) => l.startsWith('Embedded:') || l.includes('model changed'));
    expect(lines).toEqual([
      'Embedded:          2/3 memories (4-dim) (1 orphaned, run `hippo embed` to prune)',
      '                   model changed, run `hippo embed` to reindex',
    ]);
  });

  it('reads no vector element while counting them', () => {
    const [a, b] = liveIds(2);
    saveStoredVectors(root, [[a, [1, 2, 3, 4]], [b, [4, 3, 2, 1]]], 'm');
    // Array.from over a decoded Float32Array walks this iterator once per vector, so a decode shows as a call.
    // SAFETY: %TypedArray%.prototype always carries Symbol.iterator, whose receiver is a typed array.
    const proto = Object.getPrototypeOf(Float32Array.prototype) as { [Symbol.iterator]: Walk };
    const original = proto[Symbol.iterator];
    let walks = 0;
    proto[Symbol.iterator] = function (this: Float32Array) { walks++; return original.call(this); };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      handleStatus({ hippoRoot: root, args: [], flags: {} });
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
  writeEntry(root, { ...base, id, created: daysAgo(500 - seq), last_retrieved: lastRetrieved, confidence: 'observed', ...fields });
  return id;
}

function seedEveryCase(): void {
  seq = 0;
  const fresh = row(daysAgo(1), { layer: Layer.Buffer, confidence: 'verified' });
  const aged = row(daysAgo(31));
  row(daysAgo(30), { layer: Layer.Semantic, confidence: 'inferred' });
  row(daysAgo(10), { layer: Layer.Trace, confidence: 'stale', half_life_days: 2 });
  row(daysAgo(400), { pinned: true });
  row(daysAgo(1), { layer: Layer.Semantic, confidence: 'verified', pinned: true, outcome_negative: 3 });
  row('not-a-date', { confidence: 'inferred' });
  // JavaScript reads this date and SQLite's julianday does not, so only a JavaScript tally scores the row.
  row('Wed, 01 Apr 2026 00:00:00 GMT');
  const otherA = row(daysAgo(90), { confidence: 'verified', tenantId: 'other' });
  const otherB = row(daysAgo(20), { layer: Layer.Buffer, half_life_days: 1, tenantId: 'other' });
  const boosted = row(daysAgo(2), { layer: Layer.Semantic, emotional_valence: 'critical', retrieval_count: 5, outcome_positive: 2 });
  row(daysAgo(45), { confidence: 'stale', half_life_days: 30, superseded_by: boosted });
  replaceDetectedConflicts(root, [
    { memory_a_id: fresh, memory_b_id: aged, reason: 'open, one tenant', score: 0.9 },
    { memory_a_id: otherA, memory_b_id: otherB, reason: 'open, the other tenant', score: 0.8 },
    { memory_a_id: fresh, memory_b_id: boosted, reason: 'resolved below', score: 0.7 },
  ], NOW);
  const resolved = listMemoryConflicts(root).find((c) => c.reason === 'resolved below');
  if (!resolved) throw new Error('fixture conflict missing');
  resolveConflict(root, resolved.id, fresh);
  saveStoredVectors(root, [[fresh, [1, 2, 3, 4]], [otherA, [4, 3, 2, 1]], ['orphan', [0, 1, 0, 1]]], 'm');
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
  it('prints every count of a store holding each layer, tier, tenant and date shape', () => {
    useKeylessProvider();
    seedEveryCase();
    expect(status()).toEqual([
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

  it('prints zeros for an empty store', () => {
    useKeylessProvider();
    expect(status()).toEqual([
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

describe('loadStatusCounts', () => {
  it('equals a tally over every loaded entry, to the last bit of the average', () => {
    seedEveryCase();
    // Written weakest first and created strongest first: a sum over rows in any other order than loadAllEntries' ends on other last bits.
    for (let i = 0; i < 40; i++) row(daysAgo(20), { created: daysAgo(900 - i), half_life_days: 0.5 * 1.18 ** i });
    const now = new Date(NOW);
    const entries = loadAllEntries(root);
    const strengths = entries.map((e) => calculateStrength(e, now));
    const counts = loadStatusCounts(root, now, 0.2);
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
  it('selects no memory text and no JSON column from the memories table', () => {
    seedEveryCase();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { statements } = (() => {
      try {
        return recordStatements(() => handleStatus({ hippoRoot: root, args: [], flags: {} }));
      } finally {
        log.mockRestore();
      }
    })();
    const rowReads = statements.filter((sql) => /^\s*SELECT\b[^;]*\bFROM memories\b/.test(sql));
    expect(rowReads.length).toBeGreaterThan(0);
    expect(rowReads.filter((sql) => /\b(content|\w+_json)\b/.test(sql))).toEqual([]);
  });
});
