// The api reads behind `hippo recall`, driven against a real temp store: budget fit, store origin, scoped continuity, JSON rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveEmbeddingProvider } from '../../src/base/embeddings/provider.js';
import { join } from 'node:path';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { loadConfig } from '../../src/base/config/config.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { cliApiContext } from '../../src/surface/cli/api-context.js';
import { rankRecall } from '../../src/api/recall/pipeline.js';
import { handoffText, snapshotText } from '../../src/api/context-render.js';
import {
  cliRecallOrigin,
  cliRecallReranker,
  cliRecallSetting,
  fitRecallRows,
  loadCliRecallContinuity,
  recallJsonRow,
  type CliRecallSetting,
} from '../../src/api/recall/rows.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry, saveActiveTaskSnapshot, appendSessionEvent, saveSessionHandoff } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let home: string;
let hippoRoot: string;
let globalRoot: string;

const ctx = () => cliApiContext(hippoRoot, 'default');
const setting = (activeScope: string | null, primaryIsGlobal = false): CliRecallSetting => ({
  globalRoot,
  primaryIsGlobal,
  activeScope,
});

async function rankDeploy() {
  const config = loadConfig(hippoRoot);
  return rankRecall(
    { store: sqliteStore(hippoRoot), config, tenantId: 'default', embedderFor: resolveEmbeddingProvider },
    {
      query: 'deploy',
      budget: 4000,
      cost: (r) => r.tokens,
      window: { limit: 10 },
      includeSuperseded: false,
      explicitScope: null,
      activeScope: null,
      search: {
        usePhysics: false,
        physicsConfig: config.physics,
        multihop: false,
        mmr: false,
        mmrLambda: 0.7,
        localBump: 1.2,
        explain: false,
      },
    },
  );
}

function seedContinuity(): void {
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
  appendSessionEvent(hippoRoot, 'default', {
    sessionId: 'sess-1',
    eventType: 'note',
    content: 'open trail event',
    source: 'test',
  });
  appendSessionEvent(hippoRoot, 'default', {
    sessionId: 'sess-1',
    eventType: 'note',
    content: 'team trail event',
    source: 'test',
    scope: 'team-a',
  });
  appendSessionEvent(hippoRoot, 'default', {
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fitRecallRows', () => {
  it('keeps a recall inside the budget it is given, and the floor whatever it costs', async () => {
    const ranked = (await rankDeploy()).results;
    expect(ranked.length).toBe(4);
    const cost = (r: { tokens: number }): number => r.tokens;
    const budget = cost(ranked[0]!) + cost(ranked[1]!);
    const fitted = fitRecallRows(ranked, budget, 1, cost);
    expect(fitted.length).toBeGreaterThanOrEqual(1);
    expect(fitted.length).toBeLessThan(ranked.length);
    expect(fitted.reduce((sum, r) => sum + cost(r), 0)).toBeLessThanOrEqual(budget);
    expect(fitRecallRows(ranked, 0, 1, cost).map((r) => r.entry.id)).toEqual([ranked[0]!.entry.id]);
  });
});

describe('cliRecallSetting and cliRecallOrigin', () => {
  it('names the global store and marks a row global only when this store lacks it and the global store is on', () => {
    const absent = cliRecallSetting(ctx(), 'team-a');
    expect(absent).toEqual({ globalRoot: '', primaryIsGlobal: false, activeScope: 'team-a' });
    const off = cliRecallOrigin(ctx(), absent);
    expect(off.globalOn).toBe(false);
    // SAFETY: the origin reads only the isGlobal tag, so a bare id is enough of a row.
    expect(off.isGlobal({ entry: { id: 'mem_elsewhere' }, isGlobal: true } as SearchResult)).toBe(false);
    // The reach is probed when the context is built, so the global store is seen by a context built after it exists.
    initTestStore(globalRoot);
    const s = cliRecallSetting(ctx(), 'team-a');
    expect(s).toEqual({ globalRoot, primaryIsGlobal: false, activeScope: 'team-a' });
    const on = cliRecallOrigin(ctx(), s);
    expect(on.globalOn).toBe(true);
    // SAFETY: the origin reads only the isGlobal tag, so a bare id is enough of a row.
    const row = (isGlobal?: boolean) => ({ entry: { id: 'mem_x' }, isGlobal }) as SearchResult;
    expect(on.isGlobal(row(false))).toBe(false);
    expect(on.isGlobal(row())).toBe(false);
    expect(on.isGlobal(row(true))).toBe(true);
    expect(cliRecallOrigin(ctx(), { ...s, primaryIsGlobal: true }).isGlobal(row(false))).toBe(true);
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
      { store: sqliteStore(hippoRoot), config, global, tenantId: 'default', embedderFor: resolveEmbeddingProvider },
      {
        query: 'deploy',
        budget: 4000,
        cost: (r) => r.tokens,
        window: { limit: 10 },
        includeSuperseded: false,
        explicitScope: null,
        activeScope: null,
        search: {
          usePhysics: false,
          physicsConfig: config.physics,
          multihop: false,
          mmr: false,
          mmrLambda: 0.7,
          localBump: 1.2,
          explain: false,
        },
      },
    );
    const origin = cliRecallOrigin(ctx(), cliRecallSetting(ctx(), null));
    const byId = new Map(ranked.results.map((r) => [r.entry.id, origin.isGlobal(r)]));
    expect(byId.get('mem_glob_0')).toBe(true);
    expect(byId.get('mem_cli_0')).toBe(false);
  });
});

describe('loadCliRecallContinuity', () => {
  it('returns the snapshot and handoff that render, and drops private trail rows with no scope asked', async () => {
    seedContinuity();
    const c = await loadCliRecallContinuity(ctx(), setting(null), true);
    expect(snapshotText(c.activeSnapshot!)).toContain('Route recall through the api');
    expect(handoffText(c.sessionHandoff!)).toContain('Pick up at the test file.');
    expect(c.recentSessionEvents.map((e) => e.content).sort()).toEqual(['open trail event', 'team trail event']);
  });

  it('keeps only the rows in the active scope, so a row from another scope drops', async () => {
    seedContinuity();
    const c = await loadCliRecallContinuity(ctx(), setting('team-a'), true);
    expect(c.activeSnapshot).toBeNull();
    expect(c.sessionHandoff).toBeNull();
    expect(c.recentSessionEvents.map((e) => e.content)).toEqual(['team trail event']);
  });

  it('reads nothing when continuity is not asked for or the store searched is the global one', async () => {
    seedContinuity();
    const empty = { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] };
    expect(await loadCliRecallContinuity(ctx(), setting(null), false)).toEqual(empty);
    expect(await loadCliRecallContinuity(ctx(), setting(null, true), true)).toEqual(empty);
  });
});

describe('recallJsonRow and cliRecallReranker', () => {
  it('adds the --why keys, source included, only when asked', async () => {
    const top = (await rankDeploy()).results[0]!;
    expect(recallJsonRow(top, 'deploy', false, false)).not.toHaveProperty('source');
    const why = recallJsonRow(top, 'deploy', true, true);
    expect(why.source).toBe('global');
    expect(why.reason).toBe('BM25: matched terms [deploy]');
  });

  it('picks no reranker for a blank name and throws for an unknown one', () => {
    expect(cliRecallReranker('')).toBeNull();
    expect(() => cliRecallReranker('no-such-reranker')).toThrow();
  });
});
