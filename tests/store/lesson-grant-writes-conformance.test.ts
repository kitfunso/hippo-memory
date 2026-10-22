// LessonWrites' word read and batch writes, and KeyGrants, answer alike on hippo.db and on a store held in memory,
// with the same refusal, remember and grant audit rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
  expectSameOutcomes,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const START = Date.parse('2026-03-01T12:00:00.000Z');
const ALICE = 'personal:private:alice';
const REFUSED = 'the release branch is cut on mondays';
const MAIN = 'Deploy from main after the tests pass';
const KEY = 'the deploy key rotates monthly';
const ALIAS = 'my deploy alias is dpl';

let fixture: TwoTenantFixture;

// An origin named, since a write naming none takes the folder's project on hippo.db and null in memory.
const entry = (content: string, over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  ...createMemory(content, { tenantId: TENANT_A, source: 'git-learn' }),
  originProject: 'proj',
  ...over,
});

const heldByB = entry('tenant b deploys on fridays', { tenantId: TENANT_B });

beforeAll(() => {
  fixture = seedTwoTenants();
  const seeded = [
    entry(MAIN),
    entry(KEY, { scope: 'team:ops', source: 'cli' }),
    entry(ALIAS, { scope: ALICE }),
    entry('nothing about shipping here'),
    heldByB,
  ];
  for (const row of seeded) writeEntry(fixture.dir, row, { actor: 'cli' });
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

/** Each call one second after the one before. */
async function conforms<G extends 'lessonWrites' | 'keyGrants'>(group: G, calls: readonly GroupCall<G, unknown>[]) {
  const timed = calls.map((call, i): GroupCall<G, unknown> => (methods, store) => {
    vi.setSystemTime(START + i * 1000);
    return call(methods, store);
  });
  const sides = await onBothStores(fixture, group, timed);
  expectSameOutcomes(sides);
  return sides.sqlite;
}

describe('LessonWrites', () => {
  const sorted = (held: { content: string }[]) => [...held].sort((a, b) => a.content.localeCompare(b.content));

  it('reads the copies of texts within reach, writes a batch skipping a refused value, and counts it', async () => {
    const first = entry('lessons batch one');
    const refused = entry(REFUSED);
    const second = entry('lessons batch two', { scope: 'team:ops' });
    const together = [entry('written together one'), entry('written together two')];
    const { outcomes, audit } = await conforms('lessonWrites', [
      (g) => g.textsHolding(TENANT_A, [MAIN, KEY, ALIAS], null).then(sorted),
      (g) => g.textsHolding(TENANT_A, [KEY, ALIAS], ALICE).then(sorted),
      (g) => g.textsHolding(TENANT_A, [MAIN.toUpperCase(), 'Deploy from main'], null),
      (g) => g.textsHolding(TENANT_A, [heldByB.content], null),
      (g) => g.textsHolding(TENANT_A, ['Deploy  from\nmain after the tests pass', '!!'], null),
      (_g, s) =>
        s.rejections.apply({ tenantId: TENANT_A, actor: 'cli', reason: 'wrong', ownScope: null, value: REFUSED }),
      (g) => g.writeSkippingRejected([first, refused, second], 'git-learn'),
      (g) => g.writeSkippingRejected([], 'git-learn'),
      (g) => g.writeTogether(together),
      (g) => g.writeTogether([]),
      (g) => g.bumpRemembered(3),
      (_g, s) =>
        s
          .entriesByIds(
            [first, refused, second, ...together].map((e) => e.id),
            TENANT_A,
          )
          .then((rows) => rows.map((e) => [e.content, e.scope])),
      (_g, s) => s.reports.stats().then((stats) => stats.total_remembered),
    ]);
    const contents = (o: (typeof outcomes)[number]) =>
      'value' in o && Array.isArray(o.value) ? o.value.map((held: { content: string }) => held.content) : o;
    // A copy matches a row apart from spacing only: case, a missing word and another tenant's row each miss.
    expect(outcomes.slice(0, 5).map(contents)).toEqual([
      ['Deploy from main after the tests pass', 'the deploy key rotates monthly'],
      ['my deploy alias is dpl', 'the deploy key rotates monthly'],
      [],
      [],
      ['Deploy from main after the tests pass'],
    ]);
    expect(outcomes[6]).toEqual({ value: [first.id, second.id] });
    expect(
      audit.filter((row) => row.op === 'remember' && row.actor === 'git-learn').map((row) => row.targetId),
    ).toEqual([first.id, second.id]);
  });

  it('refuses an id another tenant holds: the batch skips it, the all-or-nothing write fails, row B stays', async () => {
    const taken = { ...entry('acme now owns this row'), id: heldByB.id };
    const kept = entry('written beside the foreign id');
    const lost = entry('rolled back with the foreign id');
    const rowB: GroupCall<'lessonWrites', unknown> = (_g, s) => s.entriesByIds([heldByB.id], TENANT_B);
    const { outcomes } = await conforms('lessonWrites', [
      rowB,
      (g) => g.writeSkippingRejected([taken, kept], 'git-learn'),
      rowB,
      (g) => g.writeTogether([lost, taken]),
      rowB,
      (_g, s) => s.entriesByIds([kept.id, lost.id], TENANT_A).then((rows) => rows.map((e) => e.content)),
    ]);
    expect(outcomes[1]).toEqual({ value: [kept.id] });
    expect(outcomes[3]).toEqual({ error: `ConflictError: Memory ${heldByB.id} belongs to another tenant` });
    expect(outcomes[2]).toEqual(outcomes[0]);
    expect(outcomes[4]).toEqual(outcomes[0]);
    expect(outcomes[5]).toEqual({ value: [kept.content] });
  });
});

describe('KeyGrants', () => {
  it('grants and ungrants a scope with one audit row each, and refuses a revoked key and another tenant', async () => {
    const { keys } = fixture;
    const change = (keyId: string, scope: string, op: 'auth_grant' | 'auth_ungrant', tenantId = TENANT_A) => ({
      tenantId,
      keyId,
      scope,
      op,
      actor: 'cli',
    });
    const { outcomes, audit } = await conforms('keyGrants', [
      (g) => g.changeScopeGrant(change(keys.memberA, 'team:ops', 'auth_grant')),
      (g) => g.changeScopeGrant(change(keys.memberA, 'team:eng', 'auth_grant')),
      (g) => g.changeScopeGrant(change(keys.memberA, 'team:ops', 'auth_grant')),
      (g) => g.changeScopeGrant(change(keys.memberA, 'team:eng', 'auth_ungrant')),
      (g) => g.changeScopeGrant(change(keys.memberA, 'team:none', 'auth_ungrant')),
      (g) => g.changeScopeGrant(change(keys.revokedA, 'team:ops', 'auth_grant')),
      (g) => g.changeScopeGrant(change(keys.revokedA, 'team:ops', 'auth_ungrant')),
      (g) => g.changeScopeGrant(change(keys.memberB, 'team:ops', 'auth_grant')),
      (g) => g.changeScopeGrant(change('key_nope', 'team:ops', 'auth_grant')),
      (_g, s) => s.findApiKey(keys.memberA),
      (_g, s) => s.findApiKey(keys.revokedA),
    ]);
    expect(outcomes.slice(5, 9).map((o) => 'error' in o)).toEqual([true, false, true, true]);
    expect(outcomes[9]).toMatchObject({ value: { scopes: ['team:ops'] } });
    expect(audit.filter((row) => row.op.startsWith('auth_') && row.op !== 'auth_create')).toHaveLength(6);
  });
});
