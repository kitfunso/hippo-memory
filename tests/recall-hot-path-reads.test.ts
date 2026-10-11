// The recall and context hot paths read each candidate once and a fixed number of rows, however large the store's history grows.
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRoot } from './_helpers/make-root.js';
import { recordStatements, recordStatementsAsync, countMatching } from './_helpers/count-statements.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { withRequestStoresSync } from '../src/db/request-stores.js';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { loadConfig } from '../src/core/config.js';
import { rankRecall, type RankRecallOpts } from '../src/api/recall-pipeline.js';
import { searchBothHybrid } from '../src/sharing/search-both.js';
import { pushGoal, activeGoalsWithPolicies } from '../src/store/goals.js';
import { updateStats, appendConsolidationRun } from '../src/store/index-and-stats.js';
import { finishRecallAt } from '../src/store/sqlite/store.js';
import { loadAmbientCandidates } from '../src/store/candidates.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshRoot(label: string): string {
  const root = makeRoot(label);
  roots.push(root);
  return root;
}

function memory(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
}

function seed(root: string, entries: readonly MemoryEntry[]): void {
  withRequestStoresSync(() => {
    for (const e of entries) writeEntry(root, e);
  });
}

/** Runs `write` on a short-lived handle, for fixtures the store API has no writer for. */
function onDb(root: string, write: (db: ReturnType<typeof openHippoDb>) => void): void {
  const db = openHippoDb(root);
  try {
    write(db);
  } finally {
    closeHippoDb(db);
  }
}

describe('rankRecall with a global store', () => {
  function recallOpts(root: string): RankRecallOpts {
    return {
      query: 'zephyrine cache', budget: 4000, cost: (r) => r.tokens, limit: 10, includeSuperseded: false, explicitScope: null, activeScope: null,
      search: { usePhysics: false, physicsConfig: loadConfig(root).physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, explain: false },
    };
  }

  it('loads each store once and ranks as searchBothHybrid does', async () => {
    const local = freshRoot('hp-local');
    const global = freshRoot('hp-global');
    seed(local, Array.from({ length: 6 }, (_, i) => memory(`local note ${i} on the zephyrine cache eviction`)));
    seed(global, [
      ...Array.from({ length: 6 }, (_, i) => memory(`global note ${i} on the zephyrine cache warmup`)),
      memory('local note 0 on the zephyrine cache eviction'),
    ]);
    const ctx = { hippoRoot: local, globalRoot: global, tenantId: 'default' };
    // Recency reads the clock, so both rankings see one instant.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const { result, statements } = await recordStatementsAsync(() => rankRecall(ctx, recallOpts(local)));
    expect(countMatching(statements, /memories_fts MATCH|LOWER\(content\) LIKE/)).toBe(2);

    const reloaded = await searchBothHybrid('zephyrine cache', local, global, {
      budget: 4000, cost: (r) => r.tokens, explain: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, scope: null, tenantId: 'default',
      includeSuperseded: false, recallScope: {},
    });
    const ranking = (rs: typeof reloaded): Array<[string, number]> => rs.map((r) => [r.entry.id, r.score]);
    expect(result.results.length).toBeGreaterThan(6);
    expect(ranking(result.results)).toEqual(ranking(reloaded).slice(0, 10));
  });
});

describe('activeGoalsWithPolicies', () => {
  it('reads every active goal policy in one query', () => {
    const root = freshRoot('hp-goals');
    const goals = ['ship', 'test', 'deploy'].map((goalName) =>
      pushGoal(root, { sessionId: 's1', tenantId: 'default', goalName, policy: { policyType: 'hybrid', weightRecency: 1.5 } }));
    const { result, statements } = recordStatements(() => activeGoalsWithPolicies(root, { sessionId: 's1', tenantId: 'default' }));
    expect(countMatching(statements, 'FROM retrieval_policy')).toBe(1);
    expect([...result.policies.keys()].sort()).toEqual(goals.map((g) => g.id).sort());
    expect([...result.policies.values()].every((p) => p.weightRecency === 1.5)).toBe(true);
  });
});

interface SleepRun { timestamp: string; decayed: number; merged: number; removed: number }

interface StatsFile { total_recalled: number; consolidation_runs: SleepRun[] }

describe('updateStats', () => {
  const run = (i: number): SleepRun =>
    ({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), decayed: i, merged: 0, removed: 0 });

  it('reads the same rows on every recall however many sleep runs the table holds', () => {
    const read = [50, 300].map((n) => {
      const root = freshRoot('hp-stats');
      // No writer leaves more rows than the kept cap, so the surplus goes straight into the table.
      onDb(root, (db) => {
        const insert = db.prepare('INSERT INTO consolidation_runs(timestamp, decayed, merged, removed) VALUES (?, ?, ?, ?)');
        for (let i = 0; i < n; i++) insert.run(run(i).timestamp, i, 0, 0);
      });
      return recordStatements(() => updateStats(root, { recalled: 1 })).rowsRead;
    });
    expect(read[1]).toBe(read[0]);
  });

  it('writes every kept run to stats.json, oldest first', () => {
    const root = freshRoot('hp-stats-file');
    for (const i of [3, 1, 2]) appendConsolidationRun(root, run(i));
    updateStats(root, { recalled: 1 });
    // SAFETY: writeStatsMirror serializes a LegacyStats, whose counters and runs carry these fields.
    const stats = JSON.parse(fs.readFileSync(path.join(root, 'stats.json'), 'utf8')) as StatsFile;
    expect(stats.total_recalled).toBe(1);
    expect(stats.consolidation_runs).toEqual([run(1), run(2), run(3)]);
  });
});

describe('finishRecallAt', () => {
  it('commits the audit row, trace and strengthen of one recall in one transaction', () => {
    const root = freshRoot('hp-finish');
    const entries = [memory('first zephyrine cache row'), memory('second zephyrine cache row')];
    seed(root, entries);
    const ids = entries.map((e) => e.id);
    const { result, statements } = recordStatements(() => finishRecallAt(root, {
      goalLog: [],
      audit: [{ tenantId: 'default', actor: 'cli', op: 'recall' }],
      trace: { tenantId: 'default', pipeline: 'api', query: 'zephyrine', results: ids.map((memoryId) => ({ memoryId, score: 1 })) },
      strengthen: { ids, opts: { tenantId: 'default', recallBoostAblated: false } },
    }));
    expect(countMatching(statements, /^BEGIN/)).toBe(1);
    expect(result.traceId).not.toBeNull();
    expect([...result.strengthened].sort()).toEqual([...ids].sort());
  });
});

describe('loadAmbientCandidates', () => {
  const at = (s: number): string => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
  const admit = (e: MemoryEntry): boolean => !e.content.startsWith('refused');

  it('reads past a window of refused rows without reading the rest of the store', () => {
    const read = [130, 260].map((older) => {
      const root = freshRoot('hp-ambient');
      const kept = Array.from({ length: older }, (_, i) => memory(`kept zephyrine row ${i}`, { created: at(i) }));
      const refused = Array.from({ length: 40 }, (_, i) => memory(`refused zephyrine row ${i}`, { created: at(older + i) }));
      seed(root, [...kept, ...refused]);
      const { result, rowsRead } = recordStatements(() => loadAmbientCandidates(root, 'default', 3, admit));
      const newest = [...result.entries].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 3);
      expect(newest.map((e) => e.id)).toEqual(kept.slice(-3).reverse().map((e) => e.id));
      return rowsRead;
    });
    expect(read[1]).toBe(read[0]);
  }, 60_000);
});
