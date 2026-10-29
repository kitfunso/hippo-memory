// The api reads behind `hippo recall`, driven against a real temp store: budget fit, store origin, scoped continuity, JSON rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveEmbeddingProvider } from '../../src/infra/embedding-provider.js';
import { join } from 'node:path';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { estimateTokens } from '../../src/base/util/token-text.js';
import { loadConfig } from '../../src/host/config-file.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { endLastingCommands, lastingCommand } from '../_helpers/test-cli.js';
import { rankRecall } from '../../src/api/recall/pipeline.js';
import { BUDGET_RANKED } from '../../src/api/recall/profiles.js';
import { handoffText, snapshotText } from '../../src/api/context/context-render.js';
import {
  recallRowOrigin,
  recallRerankerPick,
  recallStoreSetting,
  fitRecall,
  loadScopedContinuity,
  recallJsonRow,
  type RecallStoreSetting,
} from '../../src/api/recall/rows.js';
import { makeRoot } from '../_helpers/make-root.js';
import { saveActiveTaskSnapshot, appendSessionEvent, saveSessionHandoff } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { testInfra } from '../_helpers/infra.js';
import { evalNow } from '../../src/infra/eval-switches.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { writeEntry, sqliteStore } = sessionPerTest();

let home: string;
let hippoRoot: string;
let globalRoot: string;

const ctx = () => lastingCommand().apiContext(hippoRoot, 'default');
const setting = (activeScope: string | null, primaryIsGlobal = false): RecallStoreSetting => ({
  globalRoot,
  primaryIsGlobal,
  activeScope,
});

async function rankDeploy() {
  const config = loadConfig(hippoRoot);
  return rankRecall(
    {
      now: evalNow(),
      store: sqliteStore(hippoRoot),
      config,
      tenantId: 'default',
      embedderFor: resolveEmbeddingProvider,
    },
    {
      query: 'deploy',
      budget: 4000,
      cost: (r) => r.tokens,
      limit: 10,
      includeSuperseded: false,
      explicitScope: null,
      activeScope: null,
      multihop: false,
      mmr: false,
      mmrLambda: 0.7,
      localBump: 1.2,
      explain: false,
    },
    BUDGET_RANKED,
  );
}

async function seedContinuity(): Promise<void> {
  saveActiveTaskSnapshot(hippoRoot, 'default', {
    task: 'Route recall through the api',
    summary: 'Moving the store reads.',
    nextStep: 'Run the tests.',
    sessionId: 'sess-1',
    source: 'test',
  });
  saveSessionHandoff(hippoRoot, 'default', {
    version: 1,
    sessionId: 'sess-1',
    summary: 'Halfway.',
    nextAction: 'Pick up at the test file.',
  });
  await appendSessionEvent(hippoRoot, 'default', {
    sessionId: 'sess-1',
    eventType: 'note',
    content: 'open trail event',
    source: 'test',
  });
  await appendSessionEvent(hippoRoot, 'default', {
    sessionId: 'sess-1',
    eventType: 'note',
    content: 'team trail event',
    source: 'test',
    scope: 'team-a',
  });
  await appendSessionEvent(hippoRoot, 'default', {
    sessionId: 'sess-1',
    eventType: 'note',
    content: 'private trail event',
    source: 'test',
    scope: 'slack:private:C1',
  });
}

beforeEach(() => {
  home = makeRoot('api-recall-cli', { init: false });
  hippoRoot = join(home, '.hippo');
  globalRoot = join(home, 'global');
  vi.stubEnv('HIPPO_HOME', globalRoot);
  initTestStore(hippoRoot);
  for (const [i, text] of [
    'deploy pipeline uses blue green rollout',
    'deploy token rotation happens weekly',
    'deploy target moved to the new cluster',
    'deploy canary runs for ten minutes before promotion to the rest of the fleet',
  ].entries()) {
    writeEntry(hippoRoot, { ...createMemory(text), id: `mem_cli_${i}`, strength: 1 });
  }
});

afterEach(async () => {
  await endLastingCommands();
  vi.unstubAllEnvs();
});

describe('fitRecall', () => {
  const textOf = (rows: SearchResult[]): string => rows.map((r) => r.entry.content).join(' ');
  const plain = { render: (rows: SearchResult[]) => rows, textOf };
  const idsOf = (rows: SearchResult[]): string[] => rows.map((r) => r.entry.id);

  it('keeps the rows the room holds, and the floor whatever it costs', async () => {
    const ranked = (await rankDeploy()).results;
    expect(ranked.length).toBe(4);
    const cost = (r: { tokens: number }): number => r.tokens;
    const room = cost(ranked[0]!) + cost(ranked[1]!);
    const fitted = fitRecall(ranked, { ...plain, room, budget: Infinity, floor: 1, cost });
    expect(fitted.length).toBeGreaterThanOrEqual(1);
    expect(fitted.length).toBeLessThan(ranked.length);
    expect(fitted.reduce((sum, r) => sum + cost(r), 0)).toBeLessThanOrEqual(room);
    expect(idsOf(fitRecall(ranked, { ...plain, room: 0, budget: Infinity, floor: 1, cost }))).toEqual(
      idsOf(ranked.slice(0, 1)),
    );
  });

  it('drops the lowest-ranked row until the rendered text fits the budget, and never below the floor', async () => {
    const ranked = (await rankDeploy()).results;
    const free = { ...plain, room: 0, cost: () => 0 };
    const budget = estimateTokens(textOf(ranked.slice(0, 2)));
    expect(idsOf(fitRecall(ranked, { ...free, budget, floor: 0 }))).toEqual(idsOf(ranked.slice(0, 2)));
    expect(idsOf(fitRecall(ranked, { ...free, budget: 0, floor: 1 }))).toEqual(idsOf(ranked.slice(0, 1)));
  });
});

describe('recallStoreSetting and recallRowOrigin', () => {
  it('names the global store and marks a row global only when this store lacks it and the global store is on', () => {
    const absent = recallStoreSetting(ctx(), 'team-a');
    expect(absent).toEqual({ globalRoot: '', primaryIsGlobal: false, activeScope: 'team-a' });
    const off = recallRowOrigin(ctx(), absent);
    expect(off.globalOn).toBe(false);
    // SAFETY: the origin reads only the isGlobal tag, so a bare id is enough of a row.
    expect(off.isGlobal({ entry: { id: 'mem_elsewhere' }, isGlobal: true } as SearchResult)).toBe(false);
    // The reach is probed when the context is built, so the global store is seen by a context built after it exists.
    initTestStore(globalRoot);
    const s = recallStoreSetting(ctx(), 'team-a');
    expect(s).toEqual({ globalRoot, primaryIsGlobal: false, activeScope: 'team-a' });
    const on = recallRowOrigin(ctx(), s);
    expect(on.globalOn).toBe(true);
    // SAFETY: the origin reads only the isGlobal tag, so a bare id is enough of a row.
    const row = (isGlobal?: boolean) => ({ entry: { id: 'mem_x' }, isGlobal }) as SearchResult;
    expect(on.isGlobal(row(false))).toBe(false);
    expect(on.isGlobal(row())).toBe(false);
    expect(on.isGlobal(row(true))).toBe(true);
    expect(recallRowOrigin(ctx(), { ...s, primaryIsGlobal: true }).isGlobal(row(false))).toBe(true);
  });

  it('tags a ranked row global when it came from the global store and local when it did not', async () => {
    initTestStore(globalRoot);
    writeEntry(globalRoot, {
      ...createMemory('deploy rollback checklist lives in the shared runbook'),
      id: 'mem_glob_0',
      strength: 1,
    });
    const config = loadConfig(hippoRoot);
    const global = { store: sqliteStore(globalRoot), config: loadConfig(globalRoot) };
    const ranked = await rankRecall(
      {
        now: evalNow(),
        store: sqliteStore(hippoRoot),
        config,
        global,
        tenantId: 'default',
        embedderFor: resolveEmbeddingProvider,
      },
      {
        query: 'deploy',
        budget: 4000,
        cost: (r) => r.tokens,
        limit: 10,
        includeSuperseded: false,
        explicitScope: null,
        activeScope: null,
        multihop: false,
        mmr: false,
        mmrLambda: 0.7,
        localBump: 1.2,
        explain: false,
      },
      BUDGET_RANKED,
    );
    const origin = recallRowOrigin(ctx(), recallStoreSetting(ctx(), null));
    const byId = new Map(ranked.results.map((r) => [r.entry.id, origin.isGlobal(r)]));
    expect(byId.get('mem_glob_0')).toBe(true);
    expect(byId.get('mem_cli_0')).toBe(false);
  });
});

describe('loadScopedContinuity', () => {
  it('returns the snapshot and handoff that render, and drops private trail rows with no scope asked', async () => {
    await seedContinuity();
    const c = await loadScopedContinuity(ctx(), setting(null), true);
    expect(snapshotText(c.activeSnapshot!)).toContain('Route recall through the api');
    expect(handoffText(c.sessionHandoff!)).toContain('Pick up at the test file.');
    expect(c.recentSessionEvents.map((e) => e.content).sort()).toEqual(['open trail event', 'team trail event']);
  });

  it('keeps only the rows in the active scope, so a row from another scope drops', async () => {
    await seedContinuity();
    const c = await loadScopedContinuity(ctx(), setting('team-a'), true);
    expect(c.activeSnapshot).toBeNull();
    expect(c.sessionHandoff).toBeNull();
    expect(c.recentSessionEvents.map((e) => e.content)).toEqual(['team trail event']);
  });

  it('reads nothing when continuity is not asked for or the store searched is the global one', async () => {
    await seedContinuity();
    const empty = { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] };
    expect(await loadScopedContinuity(ctx(), setting(null), false)).toEqual(empty);
    expect(await loadScopedContinuity(ctx(), setting(null, true), true)).toEqual(empty);
  });
});

describe('recallJsonRow and recallRerankerPick', () => {
  it('adds the --why keys, source included, only when asked', async () => {
    const top = (await rankDeploy()).results[0]!;
    expect(
      recallJsonRow({ r: top, query: 'deploy', showWhy: false, isGlobal: false, now: evalNow() }),
    ).not.toHaveProperty('source');
    const why = recallJsonRow({ r: top, query: 'deploy', showWhy: true, isGlobal: true, now: evalNow() });
    expect(why.source).toBe('global');
    expect(why.reason).toBe('BM25: matched terms [deploy]');
  });

  it('names every key in snake_case, the graph hop and the ranking steps included', async () => {
    const top = (await rankDeploy()).results[0]!;
    const r: SearchResult = {
      ...top,
      graphVia: { hops: 1, relType: 'supersedes', direction: 'from' },
      rerankTrace: [{ stage: 'utility', scoreBefore: 1, scoreAfter: 0.9 }],
    };
    const row = recallJsonRow({ r, query: 'deploy', showWhy: true, isGlobal: false, now: evalNow() });
    expect(Object.keys(row).filter((key) => /[A-Z]/.test(key))).toEqual([]);
    expect(row).toMatchObject({ graph_via: r.graphVia, rerank_trace: r.rerankTrace });
  });

  it('picks no reranker for a blank name and throws for an unknown one', () => {
    expect(recallRerankerPick({ infra: testInfra() }, '')).toBeNull();
    expect(() => recallRerankerPick({ infra: testInfra() }, 'no-such-reranker')).toThrow();
  });
});
