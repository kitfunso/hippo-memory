// The api reads behind `hippo recall`, driven against a real temp store: budget fit, store origin, scoped continuity, JSON rows.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot, appendSessionEvent } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { loadConfig } from '../src/core/config.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { adminActor, type HippoDbContext } from '../src/api/index.js';
import { rankRecall } from '../src/api/recall-pipeline.js';
import { handoffText, snapshotText } from '../src/api/context-render.js';
import {
  cliRecallOrigin, cliRecallReranker, cliRecallSetting, fitRecallRows, loadCliRecallContinuity, recallJsonRow, type CliRecallSetting,
} from '../src/api/recall-cli.js';

let home: string;
let hippoRoot: string;
let globalRoot: string;

const ctx = (): HippoDbContext => ({ hippoRoot, tenantId: 'default', actor: adminActor('cli') });
const setting = (activeScope: string | null, primaryIsGlobal = false): CliRecallSetting => ({ globalRoot, primaryIsGlobal, activeScope });

async function rankDeploy() {
  const config = loadConfig(hippoRoot);
  return rankRecall({ hippoRoot, tenantId: 'default' }, {
    query: 'deploy', budget: 4000, cost: (r) => r.tokens, limit: 10, includeSuperseded: false, explicitScope: null, activeScope: null,
    search: { usePhysics: false, physicsConfig: config.physics, multihop: false, mmr: false, mmrLambda: 0.7, localBump: 1.2, explain: false },
  });
}

function seedContinuity(): void {
  saveActiveTaskSnapshot(hippoRoot, 'default', {
    task: 'Route recall through the api', summary: 'Moving the store reads.', next_step: 'Run the tests.', session_id: 'sess-1', source: 'test',
  });
  saveSessionHandoff(hippoRoot, 'default', { version: 1, sessionId: 'sess-1', summary: 'Halfway.', nextAction: 'Pick up at the test file.' });
  appendSessionEvent(hippoRoot, 'default', { session_id: 'sess-1', event_type: 'note', content: 'open trail event', source: 'test' });
  appendSessionEvent(hippoRoot, 'default', { session_id: 'sess-1', event_type: 'note', content: 'team trail event', source: 'test', scope: 'team-a' });
  appendSessionEvent(hippoRoot, 'default', {
    session_id: 'sess-1', event_type: 'note', content: 'private trail event', source: 'test', scope: 'slack:private:C1',
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hippo-api-recall-cli-'));
  hippoRoot = join(home, '.hippo');
  globalRoot = join(home, 'global');
  vi.stubEnv('HIPPO_HOME', globalRoot);
  initStore(hippoRoot);
  for (const [i, text] of ['deploy pipeline uses blue green rollout', 'deploy token rotation happens weekly', 'deploy target moved to the new cluster',
    'deploy canary runs for ten minutes before promotion to the rest of the fleet'].entries()) {
    writeEntry(hippoRoot, { ...createMemory(text), id: `mem_cli_${i}`, strength: 1 });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
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
    const s = cliRecallSetting(ctx(), 'team-a');
    expect(s).toEqual({ globalRoot, primaryIsGlobal: false, activeScope: 'team-a' });
    const off = cliRecallOrigin(ctx(), s);
    expect(off.globalOn).toBe(false);
    expect(off.isGlobal('mem_elsewhere')).toBe(false);
    initStore(globalRoot);
    const on = cliRecallOrigin(ctx(), s);
    expect(on.globalOn).toBe(true);
    expect(on.isGlobal('mem_cli_0')).toBe(false);
    expect(on.isGlobal('mem_elsewhere')).toBe(true);
  });
});

describe('loadCliRecallContinuity', () => {
  it('returns the snapshot and handoff that render, and drops private trail rows with no scope asked', () => {
    seedContinuity();
    const c = loadCliRecallContinuity(ctx(), setting(null), true);
    expect(snapshotText(c.activeSnapshot!)).toContain('Route recall through the api');
    expect(handoffText(c.sessionHandoff!)).toContain('Pick up at the test file.');
    expect(c.recentSessionEvents.map((e) => e.content).sort()).toEqual(['open trail event', 'team trail event']);
  });

  it('keeps only the rows in the active scope, so a row from another scope drops', () => {
    seedContinuity();
    const c = loadCliRecallContinuity(ctx(), setting('team-a'), true);
    expect(c.activeSnapshot).toBeNull();
    expect(c.sessionHandoff).toBeNull();
    expect(c.recentSessionEvents.map((e) => e.content)).toEqual(['team trail event']);
  });

  it('reads nothing when continuity is not asked for or the store searched is the global one', () => {
    seedContinuity();
    const empty = { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] };
    expect(loadCliRecallContinuity(ctx(), setting(null), false)).toEqual(empty);
    expect(loadCliRecallContinuity(ctx(), setting(null, true), true)).toEqual(empty);
  });
});

describe('recallJsonRow and cliRecallReranker', () => {
  it('adds the --why keys, source included, only when asked', async () => {
    const top = (await rankDeploy()).results[0]!;
    expect(recallJsonRow(top, 'deploy', false, false)).not.toHaveProperty('source');
    const why = recallJsonRow(top, 'deploy', true, true);
    expect(why.source).toBe('global');
    expect(why.reason).toBeTruthy();
  });

  it('picks no reranker for a blank name and throws for an unknown one', () => {
    expect(cliRecallReranker('')).toBeNull();
    expect(() => cliRecallReranker('no-such-reranker')).toThrow();
  });
});
