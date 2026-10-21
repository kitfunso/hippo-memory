// Cards and Goals answer alike on hippo.db and on a store held in memory: the card board's moves, leases, runs and
// promotions, and the goal stack's depth cap and the strength a completed goal passes on.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { CARD_LEASE_MS, type CardStatus } from '../../src/base/records/card.js';
import type { HandoffOutcome } from '../../src/base/session/handoff.js';
import type { HippoStore } from '../../src/store/index.js';
import type { CardCreate } from '../../src/store/port-groups.js';
import type { PushGoalOpts } from '../../src/store/port/goals.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const START = Date.parse('2026-03-01T12:00:00.000Z');
const MEMORIES = { boosted: 'mem_goal_boosted', decayed: 'mem_goal_decayed', untouched: 'mem_goal_untouched' };

let fixture: TwoTenantFixture;

beforeAll(() => {
  fixture = seedTwoTenants();
  for (const [name, id] of Object.entries(MEMORIES)) {
    writeEntry(fixture.dir, { ...createMemory(`the ${name} note`, { tenantId: TENANT_A }), id, strength: 0.5 });
  }
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

// Card, goal and policy ids are random, so each side's are named by the order its calls made them.
const made = new WeakMap<HippoStore, string[]>();
const idOf = (store: HippoStore, i: number): string => made.get(store)?.[i] ?? `unmade-${i}`;
const keep = (store: HippoStore, ...ids: (string | undefined)[]): void => {
  const fresh = ids.filter((id): id is string => id !== undefined);
  made.set(store, [...(made.get(store) ?? []), ...fresh]);
};

function namedText(store: HippoStore, text: string): string {
  return (made.get(store) ?? []).reduce((named, id, i) => named.replaceAll(id, `#${i}`), text);
}

function named<T>(store: HippoStore, value: T): T {
  return value === undefined ? value : JSON.parse(namedText(store, JSON.stringify(value)));
}

async function namedCall<G extends 'cards' | 'goals'>(call: GroupCall<G, unknown>, ...args: Parameters<typeof call>) {
  try {
    return named(args[1], await call(...args));
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    throw Object.assign(new Error(namedText(args[1], err.message)), { name: err.name });
  }
}

/** Each call one second after the one before, its answer or error with every id named by place. */
async function conforms<G extends 'cards' | 'goals'>(group: G, calls: readonly GroupCall<G, unknown>[]) {
  const timed = calls.map((call, i): GroupCall<G, unknown> => (methods, store) => {
    vi.setSystemTime(START + i * 1000);
    return namedCall(call, methods, store);
  });
  const sides = await onBothStores(fixture, group, timed);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite.outcomes;
}

describe('Cards', () => {
  const create =
    (tenantId: string, input: (store: HippoStore) => CardCreate): GroupCall<'cards', unknown> =>
    async (g, s) => {
      const card = await g.create(tenantId, input(s));
      keep(s, card.id);
      return card;
    };
  const at = (ms: number) => vi.setSystemTime(START + ms);
  // Deps read in the other id's byte order, and these ids are random, so the named ids are compared sorted.
  const sortedDeps = (detail: { deps: { parents: string[]; children: string[] } } | null) =>
    detail && {
      ...detail,
      deps: { parents: [...detail.deps.parents].sort(), children: [...detail.deps.children].sort() },
    };

  it('creates, claims, beats, blocks, reviews and completes, promoting children whose parents are all done', async () => {
    const outcomes = await conforms('cards', [
      create(TENANT_A, () => ({ title: 'parent one', repo: 'hippo', contract: 'tests pass', budget: 3 })),
      create(TENANT_A, () => ({ title: 'parent two' })),
      create(TENANT_A, (s) => ({ title: 'child', dependsOn: [idOf(s, 0), idOf(s, 1), idOf(s, 0)] })),
      create(TENANT_B, () => ({ title: 'tenant b' })),
      (g) => g.create(TENANT_A, { title: '  ' }),
      (g) => g.create(TENANT_A, { title: 'bad budget', budget: 0 }),
      (g) => g.create(TENANT_A, { title: 'bad parent', dependsOn: ['card_nope'] }),
      (g) => g.list(TENANT_A, {}),
      (g) => g.list(TENANT_A, { status: 'backlog' }),
      (g, s) => g.load(TENANT_B, idOf(s, 0)),
      (g, s) => g.claim(TENANT_A, idOf(s, 0), 'claude', 'sess-1'),
      (g, s) => g.claim(TENANT_A, idOf(s, 0), 'codex'),
      (g, s) => g.claim(TENANT_A, idOf(s, 2), 'codex'),
      (g) => g.claim(TENANT_A, 'card_nope', 'codex'),
      (g, s) => g.claim(TENANT_A, idOf(s, 1), ' '),
      (g, s) => g.heartbeat(TENANT_A, idOf(s, 0), 1),
      (g, s) => g.heartbeat(TENANT_A, idOf(s, 0), 99),
      (g, s) => g.heartbeat(TENANT_A, idOf(s, 0), 0),
      (g, s) => g.comment(TENANT_A, idOf(s, 0), 'me', 'looks good'),
      (g, s) => g.comment(TENANT_A, idOf(s, 0), 'me', ' '),
      (g) => g.comment(TENANT_A, 'card_nope', 'me', 'hello'),
      (g, s) => g.block(TENANT_A, idOf(s, 0), 'waiting on review', 1),
      (g, s) => g.block(TENANT_A, idOf(s, 0), '', 1),
      (g, s) => g.claim(TENANT_A, idOf(s, 0), 'codex'),
      (g, s) => g.review(TENANT_A, idOf(s, 0), 1),
      (g, s) => g.review(TENANT_A, idOf(s, 0), 2),
      (g, s) => g.complete(TENANT_A, idOf(s, 0), 'success', 2),
      (g, s) => g.claim(TENANT_A, idOf(s, 1), 'claude'),
      (g, s) => g.review(TENANT_A, idOf(s, 1)),
      (g, s) => g.complete(TENANT_A, idOf(s, 1), 'success'),
      // SAFETY: a value outside HandoffOutcome, which this call checks the store refuses.
      (g, s) => g.complete(TENANT_A, idOf(s, 1), 'bogus' as HandoffOutcome),
      (g, s) => g.detail(TENANT_A, idOf(s, 0)).then((detail) => sortedDeps(named(s, detail))),
      (g, s) => g.detail(TENANT_A, idOf(s, 2)).then((detail) => sortedDeps(named(s, detail))),
      (g, s) => g.runs(TENANT_A, idOf(s, 0)),
      (g) => g.detail(TENANT_A, 'card_nope'),
    ]);
    expect(outcomes[2]).toMatchObject({ value: { status: 'backlog' satisfies CardStatus } });
    expect(outcomes.slice(4, 7).every((o) => 'error' in o)).toBe(true);
    expect(outcomes[10]).toMatchObject({ value: { runId: 1, status: 'running', assigneeRuntime: 'claude' } });
    expect(outcomes.slice(11, 13)).toEqual([{ value: null }, { value: null }]);
    expect(outcomes[23]).toMatchObject({ value: { runId: 2 } });
    expect(outcomes[26]).toMatchObject({ value: { card: { status: 'done' }, promotedChildren: [] } });
    expect(outcomes[29]).toMatchObject({ value: { card: { status: 'done' }, promotedChildren: ['#2'] } });
    expect(outcomes[30]).toHaveProperty('error');
  });

  it('reclaims expired leases per tenant, shelves a failed card and reads its handoff', async () => {
    const outcomes = await conforms('cards', [
      create(TENANT_A, () => ({ title: 'leased' })),
      create(TENANT_A, () => ({ title: 'shelved' })),
      create(TENANT_B, () => ({ title: 'tenant b leased' })),
      (g, s) => g.claim(TENANT_A, idOf(s, 0), 'claude'),
      (g, s) => g.claim(TENANT_A, idOf(s, 1), 'codex'),
      (g, s) => g.claim(TENANT_B, idOf(s, 2), 'claude'),
      (g, s) => g.review(TENANT_A, idOf(s, 1)),
      (g, s) => g.complete(TENANT_A, idOf(s, 1), 'failure'),
      (g) => g.reclaimExpired(TENANT_A),
      (g) => {
        at(CARD_LEASE_MS * 2);
        return g.reclaimExpired(TENANT_A);
      },
      (g, s) => g.runs(TENANT_A, idOf(s, 0)),
      (g, s) => g.load(TENANT_A, idOf(s, 0)),
      (g, s) => g.load(TENANT_B, idOf(s, 2)),
      (_g, s) =>
        s.sessions.saveHandoff(
          TENANT_A,
          { version: 1, sessionId: 's1', summary: 'over to you', cardId: idOf(s, 1) },
          null,
        ),
      (g, s) => g.detail(TENANT_A, idOf(s, 1)),
      (g) => g.list(TENANT_A, { status: 'shelved' }),
    ]);
    expect(outcomes[8]).toEqual({ value: [] });
    expect(outcomes[9]).toEqual({ value: ['#0'] });
    expect(outcomes[11]).toMatchObject({ value: { status: 'ready', assigneeRuntime: null } });
    expect(outcomes[12]).toMatchObject({ value: { status: 'running' } });
    expect(outcomes[14]).toMatchObject({ value: { card: { status: 'shelved' }, handoff: { summary: 'over to you' } } });
  });
});

describe('Goals', () => {
  const push =
    (tenantId: string, goal: (store: HippoStore) => Omit<PushGoalOpts, 'tenantId'>): GroupCall<'goals', unknown> =>
    async (g, s) => {
      const pushed = await g.push(tenantId, goal(s));
      keep(s, pushed.id, pushed.retrievalPolicyId);
      return pushed;
    };
  const recalled =
    (goal: number, memoryId: string): GroupCall<'goals', unknown> =>
    (_g, s) =>
      s.finishRecall({
        goalLog: [
          {
            goalId: idOf(s, goal),
            memoryId,
            tenantId: TENANT_A,
            sessionId: 's1',
            recalledAt: new Date().toISOString(),
            score: 0.8,
          },
        ],
        audit: [],
      });

  it('caps the active stack at three, refuses a parent from another session, and passes an outcome to recalled rows', async () => {
    const outcomes = await conforms('goals', [
      push(TENANT_A, () => ({
        sessionId: 's1',
        goalName: 'ship',
        successCondition: 'tests pass',
        policy: { policyType: 'error-prioritized', weightRecency: 0.5 },
      })),
      push(TENANT_A, (s) => ({ sessionId: 's1', goalName: 'port', level: 1, parentGoalId: idOf(s, 0) })),
      push(TENANT_A, () => ({ sessionId: 's1', goalName: 'test', level: 1 })),
      push(TENANT_A, () => ({ sessionId: 's1', goalName: 'docs', level: 2 })),
      (g, s) => g.push(TENANT_A, { sessionId: 's2', goalName: 'stray', parentGoalId: idOf(s, 2) }),
      (g) => g.push(TENANT_A, { sessionId: 's1', goalName: 'orphan', parentGoalId: 'g_nope' }),
      push(TENANT_B, () => ({ sessionId: 's1', goalName: 'tenant b' })),
      (g) => g.sessionGoals(TENANT_A, 's1'),
      (g) => g.sessionGoals(TENANT_B, 's1'),
      (g, s) => g.resume(TENANT_A, idOf(s, 0)),
      (g, s) => g.suspend(TENANT_A, idOf(s, 3)),
      (g, s) => g.suspend(TENANT_A, idOf(s, 3)),
      recalled(4, MEMORIES.boosted),
      recalled(4, 'mem_not_held'),
      (g, s) => g.complete(TENANT_A, idOf(s, 4), { outcomeScore: 0.9 }),
      (g, s) => g.complete(TENANT_A, idOf(s, 4), { outcomeScore: 0.1 }),
      recalled(2, MEMORIES.decayed),
      (g, s) => g.complete(TENANT_A, idOf(s, 2), { outcomeScore: 0.2 }),
      recalled(0, MEMORIES.untouched),
      (g, s) => g.complete(TENANT_A, idOf(s, 0), { outcomeScore: 0.1, noPropagate: true }),
      (g) => g.complete(TENANT_A, 'g_nope', {}),
      (g, s) => g.complete(TENANT_B, idOf(s, 3), {}),
      (_g, s) =>
        s.entriesByIds(Object.values(MEMORIES), TENANT_A).then((rows) => rows.map((r) => [r.id, r.strength]).sort()),
      (g) => g.sessionGoals(TENANT_A, 's1'),
      (_g, s) =>
        s.activeGoals({ tenantId: TENANT_A, sessionId: 's1' }).then((a) => ({ ...a, policies: [...a.policies] })),
    ]);
    expect(outcomes.slice(4, 6).every((o) => 'error' in o)).toBe(true);
    const statuses = (o: (typeof outcomes)[number]) =>
      'value' in o && Array.isArray(o.value) ? o.value.map((goal: { status: string }) => goal.status) : o;
    expect(statuses(outcomes[7]!)).toEqual(['suspended', 'active', 'active', 'active']);
    expect(statuses(outcomes[23]!)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(outcomes[22]).toEqual({
      value: [
        [MEMORIES.boosted, 0.55],
        [MEMORIES.decayed, 0.425],
        [MEMORIES.untouched, 0.5],
      ],
    });
    expect(outcomes[24]).toEqual({ value: { goals: [], policies: [] } });
  });
});
