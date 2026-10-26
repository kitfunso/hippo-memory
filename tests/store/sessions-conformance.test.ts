// Sessions answers: snapshots and handoffs under continuity keys,
// events, the session-end handoff, working memory and the session-owner binding.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { SessionHandoff } from '../../src/base/session/handoff.js';
import type { SnapshotInput } from '../../src/base/ports/store/sessions.js';
import type { ContinuityKey } from '../../src/base/ports/store/types.js';
import {
  runOnFixture,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const START = Date.parse('2026-03-01T12:00:00.000Z');
const ALICE: ContinuityKey = { owner: 'alice', project: ['proj'] };
const BOB: ContinuityKey = { owner: 'bob', project: ['proj', 'other'] };
const PARTIAL: ContinuityKey = { owner: '', project: ['proj'] };

let fixture: TwoTenantFixture;

beforeAll(() => {
  fixture = seedTwoTenants();
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

/** Each call one second after the one before, so the store stamps known times and orders rows by them. */
async function conforms(calls: readonly GroupCall<'sessions', unknown>[]) {
  const timed = calls.map((call, i): GroupCall<'sessions', unknown> => (group, store) => {
    vi.setSystemTime(START + i * 1000);
    return call(group, store);
  });
  const sqlite = await runOnFixture(fixture, 'sessions', timed);
  return sqlite.outcomes;
}

const snap = (task: string, session: string | null, over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  task,
  summary: `${task} summary`,
  nextStep: `${task} next`,
  sessionId: session,
  ...over,
});

const handoff = (sessionId: string, summary: string, over: Partial<SessionHandoff> = {}) => ({
  version: 1 as const,
  sessionId,
  summary,
  ...over,
});

describe('Sessions snapshots', () => {
  it('keeps one active snapshot per key, clears and closes the newest, and keeps the other tenant out', async () => {
    const outcomes = await conforms([
      (g) => g.save(TENANT_A, 'snapshot', snap('plain', 's3'), null),
      (g) => g.save(TENANT_A, 'snapshot', snap('one', 's1'), ALICE),
      (g) => g.save(TENANT_A, 'snapshot', snap('two', 's1', { source: 'hook', scope: 'team:ops' }), ALICE),
      (g) => g.save(TENANT_A, 'snapshot', snap('bob', 's2'), BOB),
      (g) => g.save(TENANT_B, 'snapshot', snap('tenant b', 's1'), ALICE),
      (g) => g.save(TENANT_A, 'snapshot', snap('partial', 's1'), PARTIAL),
      (g) => g.loadSnapshot(TENANT_A, {}, ALICE),
      (g) => g.loadSnapshot(TENANT_A, {}, BOB),
      (g) => g.loadSnapshot(TENANT_A, {}, null),
      (g) => g.loadSnapshot(TENANT_A, {}, { owner: 'alice', project: ['other'] }),
      (g) => g.loadSnapshot(TENANT_A, { ambient: { maxAgeMs: 3000 } }, ALICE),
      (g) => g.loadSnapshot(TENANT_A, { ambient: { maxAgeMs: 60_000, sessionId: 's1' } }, ALICE),
      (g) => g.loadSnapshot(TENANT_A, { ambient: { sessionId: 'other' } }, ALICE),
      (g) => g.clear(TENANT_A, 'snapshot', { status: 'session_end', sessionId: 's2' }, BOB),
      (g) => g.clear(TENANT_A, 'snapshot', { status: 'session_end', sessionId: 's2' }, BOB),
      (g) => g.clear(TENANT_A, 'snapshot', { status: 'session_end', sessionId: 's1' }, PARTIAL),
      (g) => g.clear(TENANT_A, 'snapshot', { status: 'cleared' }),
      (g) => g.loadSnapshot(TENANT_A, {}, null),
      (g) => g.loadSnapshot(TENANT_B, {}, ALICE),
      (g) => g.clear('nobody', 'snapshot', { status: 'cleared' }),
    ]);
    expect(outcomes[5]).toHaveProperty('error');
    expect(outcomes[6]).toMatchObject({ value: { task: 'two', status: 'active', source: 'hook', scope: 'team:ops' } });
    expect(outcomes[9]).toEqual({ value: null });
    expect(outcomes.slice(13, 15)).toEqual([{ value: 1 }, { value: 0 }]);
    expect(outcomes[16]).toEqual({ value: 1 });
    expect(outcomes[17]).toMatchObject({ value: { task: 'plain' } });
  });
});

describe('Sessions events', () => {
  it('lists the newest events a session id, task and limit narrow, oldest first, per tenant', async () => {
    const outcomes = await conforms([
      (g) =>
        g.save(TENANT_A, 'event', {
          sessionId: 's1',
          eventType: 'note',
          content: 'first',
          task: 'ship',
          metadata: { n: 1 },
        }),
      (g) => g.save(TENANT_A, 'event', { sessionId: 's1', eventType: 'note', content: 'second' }),
      (g) =>
        g.save(TENANT_A, 'event', {
          sessionId: 's2',
          eventType: 'decision',
          content: 'third',
          task: 'ship',
          source: 'hook',
          scope: 'team:ops',
        }),
      (g) => g.save(TENANT_B, 'event', { sessionId: 's1', eventType: 'note', content: 'tenant b' }),
      (g) => g.read(TENANT_A, 'event', { sessionId: 's1' }),
      (g) => g.read(TENANT_A, 'event', { task: 'ship' }),
      (g) => g.read(TENANT_A, 'event', { limit: 2 }),
      (g) => g.read(TENANT_A, 'event', { limit: 0 }),
      (g) => g.read(TENANT_A, 'event', {}),
      (g) => g.read(TENANT_B, 'event', {}),
      (g) => g.read(TENANT_A, 'event', { sessionId: 'none' }),
    ]);
    const contents = (o: (typeof outcomes)[number]) =>
      'value' in o && Array.isArray(o.value) ? o.value.map((e: { content: string }) => e.content) : o;
    expect(outcomes.slice(4).map(contents)).toEqual([
      ['first', 'second'],
      ['first', 'third'],
      ['second', 'third'],
      ['third'],
      ['first', 'second', 'third'],
      ['tenant b'],
      [],
    ]);
  });
});

describe('Sessions handoffs', () => {
  it('reads the newest handoff each filter and key admits, by id per tenant, and stamps an outcome once', async () => {
    const outcomes = await conforms([
      (g) => g.save(TENANT_A, 'handoff', { handoff: handoff('s1', 'first') }, ALICE),
      (g) =>
        g.save(
          TENANT_A,
          'handoff',
          { handoff: handoff('s1', 'second', { outcome: 'success', taskId: 'ship' }) },
          ALICE,
        ),
      (g) => g.save(TENANT_A, 'handoff', { handoff: handoff('s2', 'private', { scope: 'team:Private:ops' }) }, ALICE),
      (g) =>
        g.save(
          TENANT_A,
          'handoff',
          {
            handoff: handoff('s3', 'bob', {
              repoRoot: '/repo',
              nextAction: 'merge',
              artifacts: ['a.txt'],
              constraints: ['no force push'],
              evidence: { gitRef: 'abc', dirtyTree: false, testStatus: 'pass' },
              targetRuntime: 'codex',
              cardId: 'card-1',
            }),
          },
          BOB,
        ),
      (g) => g.save(TENANT_B, 'handoff', { handoff: handoff('s1', 'tenant b') }, null),
      (g) => g.save(TENANT_A, 'handoff', { handoff: handoff('s4', 'partial') }, PARTIAL),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: 's1' }, ALICE),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: null }, ALICE),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: null, scopeFilter: 'default-deny' }, ALICE),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: null, unfinishedOnly: true, excludeSessionId: 's2' }, ALICE),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: null, unfinishedOnly: true }, ALICE),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: null, maxAgeMs: 8000 }, null),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: null, maxAgeMs: 1000 }, null),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: 's1' }, BOB),
      (g) => g.read(TENANT_A, 'handoff', { id: 1 }),
      (g) => g.read(TENANT_B, 'handoff', { id: 1 }),
      (g) => g.read(TENANT_B, 'handoff', { id: 5 }),
      (g) => g.save(TENANT_A, 'handoff', { sessionId: 's2', outcome: 'partial' }),
      (g) => g.save(TENANT_A, 'handoff', { sessionId: 's2', outcome: 'failure' }),
      (g) => g.save(TENANT_A, 'handoff', { sessionId: 's1', outcome: 'failure' }),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: 's2', unfinishedOnly: true }, ALICE),
    ]);
    expect(outcomes[5]).toHaveProperty('error');
    expect(outcomes[6]).toMatchObject({ value: { summary: 'second', outcome: 'success' } });
    expect(outcomes[8]).toMatchObject({ value: { summary: 'second' } });
    expect(outcomes[9]).toEqual({ value: null });
    expect(outcomes.slice(17, 20)).toEqual([{ value: 1 }, { value: 0 }, { value: 0 }]);
    expect(outcomes[20]).toMatchObject({ value: { summary: 'private', outcome: 'partial' } });
  });
});

describe('Sessions, the session-end handoff', () => {
  const derived = (summary: string) => ({ task: 'transcript task', summary, nextStep: 'carry on' });

  it('writes from the active snapshot or the transcript, once per change, and rewrites a transcript read in place', async () => {
    const outcomes = await conforms([
      (g) => g.save(TENANT_A, 'snapshot', snap('ship', 's1'), ALICE),
      (g) => g.save(TENANT_A, 'event', { sessionId: 's1', eventType: 'session_complete', content: 'success' }),
      (g) => g.save(TENANT_A, 'handoff', { sessionEnd: { sessionId: 's1', evidence: { gitRef: 'abc' } } }, ALICE),
      (g) => g.save(TENANT_A, 'handoff', { sessionEnd: { sessionId: 's1', evidence: null } }, ALICE),
      (g) =>
        g.save(
          TENANT_A,
          'handoff',
          { sessionEnd: { sessionId: 's9', evidence: null, derived: derived('read one') } },
          ALICE,
        ),
      (g) =>
        g.save(
          TENANT_A,
          'handoff',
          {
            sessionEnd: { sessionId: 's9', evidence: { dirtyTree: true }, derived: derived('read two'), inPlace: true },
          },
          ALICE,
        ),
      (g) =>
        g.save(
          TENANT_A,
          'handoff',
          { sessionEnd: { sessionId: 's9', evidence: null, derived: derived('read two') } },
          ALICE,
        ),
      (g) => g.save(TENANT_A, 'handoff', { sessionEnd: { sessionId: 's9', evidence: null } }, null),
      (g) => g.read(TENANT_A, 'handoff', { sessionId: 's9' }, ALICE),
      (g) => g.save(TENANT_A, 'handoff', { sessionEnd: { sessionId: 's1', evidence: null } }, PARTIAL),
      (g) => g.save(TENANT_A, 'snapshot', snap('compacted', 's5', { source: 'pre-compact' }), BOB),
      (g) =>
        g.save(
          TENANT_A,
          'handoff',
          { sessionEnd: { sessionId: 's5', evidence: null, derived: derived('after compaction'), inPlace: true } },
          BOB,
        ),
      (g) => g.save(TENANT_B, 'handoff', { sessionEnd: { sessionId: 's1', evidence: null } }, null),
    ]);
    expect(outcomes[2]).toMatchObject({ value: { taskId: 'ship', outcome: 'success' } });
    expect(outcomes[3]).toEqual({ value: null });
    expect(outcomes[6]).toEqual({ value: null });
    expect(outcomes[7]).toEqual({ value: null });
    expect(outcomes[8]).toMatchObject({ value: { summary: 'read two', evidence: { derivedFrom: 'transcript' } } });
    expect(outcomes[9]).toHaveProperty('error');
    expect(outcomes[11]).toMatchObject({ value: { summary: 'after compaction' } });
    expect(outcomes[12]).toEqual({ value: null });
  });
});

describe('Sessions working memory', () => {
  const push =
    (i: number): GroupCall<'sessions', unknown> =>
    (g) => {
      const item = { scope: 'task', content: `note ${i}`, importance: i % 3 === 0 ? 0.5 : i % 3 };
      const sessionId = i % 2 === 0 ? 's1' : 's2';
      const tagged = { ...item, sessionId, taskId: 't-1', metadata: { source: 'hook' } };
      return g.save(TENANT_A, 'working_memory', i === 1 ? tagged : { ...item, sessionId });
    };

  it('evicts past twenty per scope, reads by importance then age, and clears what a filter names', async () => {
    const pushes = Array.from({ length: 22 }, (_, i) => push(i));
    const outcomes = await conforms([
      ...pushes,
      (g) => g.save(TENANT_A, 'working_memory', { scope: 'other', content: 'other scope' }),
      (g) => g.save(TENANT_B, 'working_memory', { scope: 'task', content: 'tenant b' }),
      (g) => g.read(TENANT_A, 'working_memory', { scope: 'task' }),
      (g) => g.read(TENANT_A, 'working_memory', { scope: 'task', sessionId: 's1', limit: 3 }),
      (g) => g.read(TENANT_A, 'working_memory', { limit: 0 }),
      (g) => g.read(TENANT_B, 'working_memory', { scope: 'task' }),
      (g) => g.clear(TENANT_A, 'working_memory', { scope: 'task', sessionId: 's2' }),
      (g) => g.clear(TENANT_A, 'working_memory', {}),
      (g) => g.read(TENANT_A, 'working_memory', {}),
    ]);
    expect(outcomes[24]).toMatchObject({ value: { length: 20 } });
    expect(outcomes[25]).toMatchObject({ value: { length: 3 } });
    expect(outcomes[26]).toMatchObject({ value: { length: 1 } });
    expect(outcomes.slice(28)).toEqual([{ value: 10 }, { value: 11 }, { value: [] }]);
  });
});

describe('Sessions.bindSessionOwner', () => {
  it('keeps the first owner per tenant and session, and a first bind prunes bindings past retention', async () => {
    const outcomes = await conforms([
      (g) => g.bindSessionOwner(TENANT_A, 's1', 'alice', 60_000),
      (g) => g.bindSessionOwner(TENANT_A, 's1', 'bob', 60_000),
      (g) => g.bindSessionOwner(TENANT_B, 's1', 'bob', 60_000),
      (g) => g.bindSessionOwner(TENANT_A, 's2', 'carol', 1500),
      (g) => g.bindSessionOwner(TENANT_A, 's1', 'dave', 60_000),
      (g) => g.bindSessionOwner(TENANT_B, 's1', 'erin', 60_000),
      (g) => g.bindSessionOwner(TENANT_A, 's3', 'frank', 0),
    ]);
    expect(outcomes).toEqual([
      { value: 'alice' },
      { value: 'alice' },
      { value: 'bob' },
      { value: 'carol' },
      { value: 'dave' },
      { value: 'bob' },
      { value: 'frank' },
    ]);
  });
});
