// Conflicts and Dormant answer alike on hippo.db and on a store held in memory: conflict pages and resolutions with
// their audit rows, and dormant rows listed, restored and forgotten within reach of the caller's own scope.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { DEFAULT_HALF_LIFE_DAYS, strengthOptionsOf, type MemoryEntry } from '../../src/base/memory/memory.js';
import { ALL_TENANTS } from '../../src/base/util/tenant.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { ConflictResolution, ConflictRowPage, ConflictSide } from '../../src/store/port/conflicts.js';
import { insertDormantRow } from '../../src/store/sqlite/dormant-rows.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
  valueAt,
} from '../_helpers/store-conformance.js';
import { listMemoryConflicts, replaceDetectedConflicts, writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const START = Date.parse('2026-03-01T12:00:00.000Z');
const DETECTED_AT = '2026-01-01T00:00:00.000Z';
const ALICE = 'personal:private:alice';

let fixture: TwoTenantFixture;
const rows: Record<string, MemoryEntry> = {};
const conflictIds: Record<string, number> = {};

function seedRow(name: string, content: string, over: Parameters<typeof createMemory>[1] = {}): MemoryEntry {
  const row = createMemory(content, { tenantId: TENANT_A, ...over });
  writeEntry(fixture.dir, { ...row, originProject: 'proj' }, { actor: 'cli' });
  rows[name] = row;
  return row;
}

function seedConflicts(): void {
  seedRow('keep', 'deploys run from main');
  seedRow('lose', 'deploys never run from main');
  seedRow('redis', 'the cache lives in redis');
  seedRow('memcached', 'the cache lives in memcached');
  seedRow('copy', 'The cache lives in  MEMCACHED');
  seedRow('raw', 'raw line: deploys run from a branch', { kind: 'raw' });
  seedRow('kafka', 'the queue is kafka', { scope: 'team:ops' });
  seedRow('rabbit', 'the queue is rabbit', { scope: 'team:ops' });
  seedRow('b1', 'tenant b says yes', { tenantId: TENANT_B });
  seedRow('b2', 'tenant b says no', { tenantId: TENANT_B });
  const pairs = { weaken: ['keep', 'lose'], reject: ['redis', 'memcached'], remove: ['keep', 'raw'] } as const;
  const more = { scoped: ['kafka', 'rabbit'], tenantB: ['b1', 'b2'], crossTenant: ['keep', 'b1'] } as const;
  const named = Object.entries({ ...pairs, ...more });
  const detected = named.map(([, [a, b]]) => ({
    memory_a_id: rows[a]!.id,
    memory_b_id: rows[b]!.id,
    reason: 'contradiction',
    score: 0.9,
  }));
  replaceDetectedConflicts(fixture.dir, detected, DETECTED_AT);
  const pairOf = (...ids: string[]): string => ids.sort().join(' ');
  for (const conflict of listMemoryConflicts(fixture.dir)) {
    const stored = pairOf(conflict.memory_a_id, conflict.memory_b_id);
    const name = named.find(([, [a, b]]) => pairOf(rows[a]!.id, rows[b]!.id) === stored);
    if (name) conflictIds[name[0]] = conflict.id;
  }
  expect(Object.keys(conflictIds).sort()).toEqual(['reject', 'remove', 'scoped', 'tenantB', 'weaken']);
}

function seedDormant(): void {
  const db = openHippoDb(fixture.dir);
  try {
    const dormant = (name: string, content: string, at: string, over: Partial<MemoryEntry> = {}) => {
      // An origin named, since a write naming none takes the folder's project on hippo.db and null in memory.
      const entry = { ...createMemory(content, { tenantId: TENANT_A }), originProject: 'proj', ...over };
      insertDormantRow(db, { entry, strength: 0.01, reason: 'decay', dormantAt: at });
      rows[name] = entry;
    };
    dormant('d1', 'the staging host was build-07', '2026-02-01T00:00:00.000Z');
    dormant('d2', 'the Staging host moved to build-09', '2026-02-02T00:00:00.000Z');
    dormant('mine', 'my staging desk is by the window', '2026-02-03T00:00:00.000Z', { scope: ALICE });
    dormant('dB', 'tenant b staging host', '2026-02-01T00:00:00.000Z', { tenantId: TENANT_B });
    dormant('live', 'an older copy of a live row', '2026-02-04T00:00:00.000Z', { id: rows.keep!.id });
  } finally {
    closeHippoDb(db);
  }
}

beforeAll(() => {
  fixture = seedTwoTenants();
  seedConflicts();
  seedDormant();
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));

afterEach(() => vi.useRealTimers());

// hippo.db stamps a resolution with SQL datetime('now'), which reads the real clock, so its value is named by format.
function stamped<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d"/g, '"stamped"'));
}

/** Each call one second after the one before. */
async function conforms<G extends 'conflicts' | 'dormant'>(group: G, calls: readonly GroupCall<G, unknown>[]) {
  const timed = calls.map((call, i): GroupCall<G, unknown> => async (methods, store) => {
    vi.setSystemTime(START + i * 1000);
    return stamped((await call(methods, store)) ?? null);
  });
  const sides = await onBothStores(fixture, group, timed);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite.outcomes;
}

const side = (name: string): ConflictSide => ({ id: rows[name]!.id, scope: rows[name]!.scope ?? null });

function resolution(conflict: string, keep: string, loser: string, fate: ConflictResolution['fate']) {
  return {
    conflictId: conflictIds[conflict]!,
    keep: side(keep),
    loser: side(loser),
    fate,
    actor: 'me',
    reason: 'wrong',
  };
}

describe('Conflicts', () => {
  it('pages conflicts newest change first, resolves each fate once, and leaves another tenant and a moved side alone', async () => {
    const ids = (page: { rows: readonly { conflict: { id: number } }[] }) => page.rows.map((r) => r.conflict.id);
    const outcomes = await conforms('conflicts', [
      (g) => g.list({ tenantId: TENANT_A, status: 'open', limit: 10 }),
      async (g) => {
        const first = await g.list({ tenantId: ALL_TENANTS, status: '*', limit: 2 });
        const second = await g.list({ tenantId: ALL_TENANTS, status: '*', limit: 10, after: first.next ?? undefined });
        return [first, second];
      },
      (g) => g.list({ tenantId: TENANT_B, status: 'open', limit: 10 }),
      (g) => g.list({ tenantId: 'nobody', status: '*', limit: 10 }),
      (g) => g.get(TENANT_A, conflictIds.weaken!),
      (g) => g.get(TENANT_B, conflictIds.weaken!),
      (g) => g.get(TENANT_A, 9999),
      (g) => g.resolve(TENANT_B, resolution('weaken', 'keep', 'lose', { kind: 'weaken' })),
      (g) => g.resolve(TENANT_A, resolution('weaken', 'keep', 'redis', { kind: 'weaken' })),
      (g) =>
        g.resolve(TENANT_A, {
          ...resolution('scoped', 'kafka', 'rabbit', { kind: 'weaken' }),
          keep: { ...side('kafka'), scope: null },
        }),
      (g) => g.resolve(TENANT_A, resolution('weaken', 'keep', 'lose', { kind: 'weaken' })),
      (g) => g.resolve(TENANT_A, resolution('weaken', 'keep', 'lose', { kind: 'weaken' })),
      (g) => g.resolve(TENANT_A, resolution('reject', 'redis', 'memcached', { kind: 'reject', ownScope: null })),
      (g) => g.resolve(TENANT_A, resolution('remove', 'keep', 'raw', { kind: 'remove' })),
      (g) => g.list({ tenantId: TENANT_A, status: 'resolved', limit: 10 }).then(ids),
      (g) => g.list({ tenantId: ALL_TENANTS, status: 'resolved', limit: 10 }),
      (g) => g.list({ tenantId: TENANT_A, status: 'open', limit: 10 }),
      (g) => g.get(TENANT_A, conflictIds.weaken!),
      (_g, s) =>
        s
          .entriesByIds(
            ['keep', 'lose', 'redis', 'memcached', 'copy', 'raw'].map((n) => rows[n]!.id),
            TENANT_A,
          )
          .then((found) =>
            found.map((e) => ({ content: e.content, halfLifeDays: e.halfLifeDays, conflictsWith: e.conflictsWith })),
          ),
      (_g, s) => s.rejections.list(TENANT_A),
    ]);
    expect(ids(valueAt<ConflictRowPage>(outcomes, 0))).toHaveLength(4);
    expect(outcomes.slice(7, 13).map((o) => ('value' in o ? o.value : o))).toEqual([
      false,
      false,
      false,
      true,
      false,
      true,
    ]);
    expect(outcomes[13]).toEqual({ value: true });
    // A tenant's read drops a conflict whose loser is gone; the every-tenant read keeps it with that member null.
    expect(outcomes[14]).toEqual({ value: [conflictIds.weaken] });
    type Member = { kind: string } | null;
    const everyTenant = valueAt<{ rows: { conflict: { id: number }; a: Member; b: Member }[] }>(outcomes, 15);
    expect(everyTenant.rows.map((r) => [r.conflict.id, [r.a, r.b].filter((m) => m === null).length])).toEqual([
      [conflictIds.remove, 1],
      [conflictIds.reject, 1],
      [conflictIds.weaken, 0],
    ]);
    expect(outcomes[17]).toMatchObject({ value: { conflict: { status: 'resolved', updated_at: 'stamped' } } });
  });
});

describe('Dormant', () => {
  const revival = { halfLifeDays: DEFAULT_HALF_LIFE_DAYS, strength: strengthOptionsOf(undefined) };
  const restore =
    (name: string, ownScope: string | null = null): GroupCall<'dormant', unknown> =>
    (g) =>
      g.restore(TENANT_A, { id: rows[name]!.id, actor: 'me', ownScope, revival });

  it('lists within reach, restores once, refuses a live id, and forgets with one audit row each', async () => {
    const outcomes = await conforms('dormant', [
      (g) => g.list(TENANT_A, null, {}),
      (g) => g.list(TENANT_A, null, { query: '  STAGING build ' }),
      (g) => g.list(TENANT_A, null, { limit: 1 }),
      (g) => g.list(TENANT_A, null, { limit: 0 }),
      (g) => g.list(TENANT_A, ALICE, {}),
      (g) => g.list(TENANT_A, 'personal:private:bob', {}),
      (g) => g.list(TENANT_B, null, {}),
      (g) => g.holds(TENANT_A, null, rows.mine!.id),
      (g) => g.holds(TENANT_A, ALICE, rows.mine!.id),
      (g) => g.holds(TENANT_B, null, rows.d1!.id),
      restore('d1'),
      restore('d1'),
      restore('live'),
      restore('mine'),
      (g) => g.forget(TENANT_A, null, rows.d2!.id, 'me'),
      (g) => g.forget(TENANT_A, null, rows.d2!.id, 'me'),
      (g) => g.forget(TENANT_A, ALICE, rows.mine!.id, 'me'),
      (g) => g.list(TENANT_A, ALICE, {}),
      (_g, s) => s.entriesByIds([rows.d1!.id], TENANT_A),
      (_g, s) => s.reports.stats().then((stats) => stats.total_forgotten),
    ]);
    const listed = (o: (typeof outcomes)[number]) =>
      'value' in o && Array.isArray(o.value) ? o.value.map((m: { content: string }) => m.content) : o;
    expect(listed(outcomes[1]!)).toEqual(['the Staging host moved to build-09', 'the staging host was build-07']);
    expect(outcomes.slice(7, 10)).toEqual([{ value: false }, { value: true }, { value: false }]);
    expect(outcomes[10]).toMatchObject({ value: { status: 'restored', entry: { id: rows.d1!.id } } });
    expect(outcomes.slice(11, 14)).toEqual([
      { value: { status: 'missing' } },
      { value: { status: 'active' } },
      { value: { status: 'missing' } },
    ]);
    expect(outcomes.slice(14, 17)).toEqual([{ value: true }, { value: false }, { value: true }]);
    expect(outcomes[19]).toEqual({ value: 2 });
  });
});
