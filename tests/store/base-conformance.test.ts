// HippoStore's own methods answer alike on hippo.db and on a store held in memory: key lookup, recall's candidate
// search and writes, id and raw reads, continuity, the planning-fallacy read, audit appends, counters and the ledger.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { predictionMirror } from '../../src/base/records/prediction.js';
import type { RecallSearchArgs } from '../../src/store/port/recall-writes.js';
import type { ContinuityKey } from '../../src/store/port/types.js';
import type { PredictionSave } from '../../src/store/port/predictions.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
  valueAt,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const START = Date.parse('2026-03-01T12:00:00.000Z');
const ALICE = 'personal:private:alice';
const KEY: ContinuityKey = { owner: 'alice', project: ['proj'] };

let fixture: TwoTenantFixture;
const rows: Record<string, MemoryEntry> = {};

function seedRow(name: string, content: string, over: Partial<MemoryEntry> = {}, at = 0): void {
  const created = new Date(Date.parse('2026-02-01T00:00:00.000Z') + at * 60_000).toISOString();
  const row = { ...createMemory(content, { tenantId: TENANT_A }), originProject: 'proj', created, ...over };
  writeEntry(fixture.dir, row, { actor: 'cli' });
  rows[name] = row;
}

function seed(): void {
  seedRow('pipeline', 'the deploy pipeline runs nightly', { tags: ['ci'] }, 1);
  seedRow('main', 'deploys go out from main after review', {}, 2);
  seedRow('deployTwice', 'deploy early, deploy often, deploy small', {}, 3);
  seedRow('cache', 'the cache lives in redis', {}, 4);
  seedRow('team', 'the deploy key sits in the ops vault', { scope: 'team:ops' }, 5);
  seedRow('mine', 'my deploy alias is dpl', { scope: ALICE }, 6);
  seedRow('old', 'deploys went out on fridays', { supersededBy: 'mem_newer' }, 7);
  seedRow('raw1', 'raw: standup said the deploy slipped', { kind: 'raw', sourceSessionId: 's1' }, 8);
  seedRow('raw2', 'raw: standup in the other project', { kind: 'raw', originProject: 'other' }, 9);
  seedRow('raw3', 'raw: a user-global note', { kind: 'raw', originProject: '' }, 10);
  seedRow('rawB', 'raw: tenant b standup', { kind: 'raw', tenantId: TENANT_B }, 11);
  seedRow('b', 'tenant b deploy notes', { tenantId: TENANT_B }, 12);
}

beforeAll(() => {
  fixture = seedTwoTenants();
  seed();
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

/** Each call one second after the one before. */
async function conforms(calls: readonly GroupCall<'base', unknown>[]) {
  const timed = calls.map((call, i): GroupCall<'base', unknown> => (store, same) => {
    vi.setSystemTime(START + i * 1000);
    return call(store, same);
  });
  const sides = await onBothStores(fixture, 'base', timed);
  expectSameOutcomes(sides);
  return sides.sqlite;
}

const search = (over: Partial<RecallSearchArgs> = {}): RecallSearchArgs => ({
  limit: 20,
  tenantId: TENANT_A,
  explicitScopeMode: 'exact',
  includeSuperseded: false,
  ownScope: undefined,
  ...over,
});
const contents = (entries: readonly MemoryEntry[]) => entries.map((e) => e.content);
const id = (name: string): string => rows[name]!.id;

describe('HippoStore base reads', () => {
  it('finds keys, searches recall candidates by tier and scope, and reads ids and raw rows', async () => {
    const { keys } = fixture;
    const { outcomes } = await conforms([
      (s) => s.findApiKey(keys.adminA),
      (s) => s.findApiKey(keys.revokedA),
      (s) => s.findApiKey('key_nope'),
      (s) => s.searchRecallEntries('deploy', search()).then(contents),
      (s) => s.searchRecallEntries('deploy', search({ ownScope: ALICE })).then(contents),
      (s) => s.searchRecallEntries('deploy', search({ requestedScope: 'team:ops' })).then(contents),
      (s) =>
        s
          .searchRecallEntries('deploy', search({ requestedScope: 'team:ops', explicitScopeMode: 'additive' }))
          .then(contents),
      (s) => s.searchRecallEntries('deploy', search({ includeSuperseded: true, limit: 2 })).then(contents),
      (s) => s.searchRecallEntries('ploy', search()).then(contents),
      (s) => s.searchRecallEntries('zzz nothing', search({ limit: 3 })).then(contents),
      (s) => s.searchRecallEntries('deploy', search({ originProjects: ['other'] })).then(contents),
      (s) => s.searchRecallEntries('deploy', search({ tenantId: TENANT_B })).then(contents),
      (s) => s.entriesByIds([id('cache'), id('pipeline'), 'mem_none', id('b'), id('pipeline')], TENANT_A),
      (s) => s.freshRawEntries(10, TENANT_A, undefined, null).then(contents),
      (s) => s.freshRawEntries(10, TENANT_A, 's1', null).then(contents),
      (s) => s.freshRawEntries(10, TENANT_A, undefined, ['proj']).then(contents),
      (s) => s.freshRawEntries(1, TENANT_B, undefined, null).then(contents),
      (s) =>
        s.activeGoals({ tenantId: TENANT_A, sessionId: 'none' }).then((a) => ({ ...a, policies: [...a.policies] })),
    ]);
    expect(outcomes.slice(0, 3).map((o) => 'value' in o && o.value !== null)).toEqual([true, true, false]);
    expect(outcomes[3]).toMatchObject({ value: expect.arrayContaining(['the deploy pipeline runs nightly']) });
    expect(outcomes[12]).toMatchObject({ value: [{ id: id('pipeline') }, { id: id('cache') }] });
    expect(outcomes[13]).toEqual({
      value: ['raw: a user-global note', 'raw: standup in the other project', 'raw: standup said the deploy slipped'],
    });
    expect(outcomes[15]).toEqual({ value: ['raw: a user-global note', 'raw: standup said the deploy slipped'] });
  });
});

describe('HippoStore continuity', () => {
  it('reads the keyed snapshot with its session handoff and newest events, oldest first', async () => {
    const { outcomes } = await conforms([
      (s) =>
        s.sessions.saveSnapshot(TENANT_A, { task: 'ship', summary: 'half', next_step: 'merge', session_id: 's1' }, KEY),
      (s) => s.sessions.saveHandoff(TENANT_A, { version: 1, sessionId: 's1', summary: 'carry on' }, KEY),
      (s) => s.sessions.saveHandoff(TENANT_A, { version: 1, sessionId: 's1', summary: 'carry on again' }, KEY),
      (s) => s.sessions.appendEvent(TENANT_A, { session_id: 's1', event_type: 'note', content: 'one' }),
      (s) => s.sessions.appendEvent(TENANT_A, { session_id: 's1', event_type: 'note', content: 'two' }),
      (s) => s.sessions.appendEvent(TENANT_A, { session_id: 's1', event_type: 'note', content: 'three' }),
      (s) => s.sessions.appendEvent(TENANT_A, { session_id: 's2', event_type: 'note', content: 'other session' }),
      (s) => s.continuity(TENANT_A, 2, KEY),
      (s) => s.continuity(TENANT_A, 8, null),
      (s) => s.continuity(TENANT_A, 8, { owner: 'bob', project: ['proj'] }),
      (s) => s.continuity(TENANT_A, 8, { owner: '', project: ['proj'] }),
      (s) => s.continuity(TENANT_B, 8, null),
    ]);
    expect(outcomes[7]).toMatchObject({
      value: {
        activeSnapshot: { task: 'ship' },
        sessionHandoff: { summary: 'carry on again' },
        recentSessionEvents: [{ content: 'two' }, { content: 'three' }],
      },
    });
    expect(outcomes[11]).toEqual({ value: { activeSnapshot: null, sessionHandoff: null, recentSessionEvents: [] } });
  });
});

describe('HippoStore base writes', () => {
  const claim = (classTag: string, tenantId = TENANT_A): PredictionSave => {
    const opts = { classTag, claimText: `the ${classTag} lands on time`, estimateValue: 2, estimateUnit: 'days' };
    return { ...opts, mirror: predictionMirror(tenantId, opts, 30) };
  };

  it('resolves a claim to its class baserate, appends audit rows, finishes a recall and counts it', async () => {
    const saves = [claim('deploy-work'), claim('deploy-work'), claim('cache-work')];
    const { outcomes, audit } = await conforms([
      ...saves.map(
        (save): GroupCall<'base', unknown> =>
          (s) =>
            s.predictions.savePrediction(TENANT_A, save, 'cli'),
      ),
      (s) => s.predictions.closePrediction(TENANT_A, 1, { closureState: 'closed', actualValue: 4 }, 'cli'),
      (s) => s.predictions.closePrediction(TENANT_A, 2, { closureState: 'closed', actualValue: 3 }, 'cli'),
      (s) => s.planningFallacyEvidence(TENANT_A, ['deploy', 'work']),
      (s) => s.planningFallacyEvidence(TENANT_A, ['work']),
      (s) => s.planningFallacyEvidence(TENANT_A, ['nothing']),
      (s) => s.planningFallacyEvidence(TENANT_B, ['deploy', 'work']),
      (s) =>
        s.appendAuditEvents([
          { tenantId: TENANT_A, actor: 'cli', op: 'recall', metadata: { n: 1 } },
          { tenantId: TENANT_B, actor: 'cli', op: 'recall', targetId: id('b') },
        ]),
      (s) => s.appendAuditEvents([]),
      (s) =>
        s.finishRecall({
          goalLog: [],
          audit: [{ tenantId: TENANT_A, actor: 'api_key:caller', op: 'recall', metadata: { results: 2 } }],
          trace: {
            tenantId: TENANT_A,
            sessionId: 's1',
            pipeline: 'api',
            query: 'deploy',
            results: [{ memoryId: id('main'), score: 0.5 }],
          },
          strengthen: {
            ids: [id('main'), id('main'), id('b')],
            opts: { tenantId: TENANT_A, recallBoostAblated: false },
          },
        }),
      (s) =>
        s
          .entriesByIds([id('main'), id('cache')], TENANT_A)
          .then((found) => found.map((e) => [e.retrievalCount, e.strength, e.lastRetrieved])),
      (s) => s.entriesByIds([id('b')], TENANT_B).then((found) => found.map((e) => e.retrievalCount)),
      (s) => s.bumpRecallStats(2),
      (s) => s.reports.stats().then((stats) => stats.total_recalled),
      (s) =>
        s.recordTokens({
          tenantId: TENANT_A,
          sessionId: 's1',
          surface: 'hook',
          event: 'inject',
          items: 3,
          tokens: 120,
        }),
      (s) =>
        s.recordTokens({
          tenantId: TENANT_A,
          sessionId: 's1',
          surface: 'hook',
          event: 'skip',
          items: 0,
          tokens: 80,
          hash: 'h1',
        }),
      (s) => s.reports.tokenUse(TENANT_A, new Date(START).toISOString()),
      (s) => s.reports.tokenUse(TENANT_B, new Date(START).toISOString()),
    ]);
    expect(outcomes[5]).toMatchObject({
      value: { classTag: 'deploy-work', tiebreak: false, baserate: { nClosed: 2 } },
    });
    expect(outcomes[7]).toEqual({ value: { classTag: null, tiebreak: false, baserate: null } });
    // A repeated id moves once, and an id of another tenant than the strengthen names does not move.
    const strengthened = valueAt<[number, number, string][]>(outcomes, 12);
    expect(strengthened.map(([count]) => count)).toEqual([1, 0]);
    expect(strengthened[0]?.[2]).toBe(new Date(START + 11_000).toISOString());
    expect(outcomes[13]).toEqual({ value: [0] });
    expect(outcomes[15]).toEqual({ value: 2 });
    expect(audit.filter((row) => row.op === 'recall').map((row) => row.tenantId)).toEqual([
      TENANT_A,
      TENANT_B,
      TENANT_A,
    ]);
  });
});
