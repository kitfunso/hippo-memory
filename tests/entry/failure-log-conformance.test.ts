// FailureLog and lessonWrites.contentsWithTag answer alike on hippo.db and on a store held in memory, over two tenants
// that log the same request id.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { FailureEvent, FailureOutcome } from '../../src/entry/store-kit.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { inMemoryFailureLogStore } from '../_helpers/in-memory-failure-log-store.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:05.000Z';
const TAG = 'auto-captured';

type Value = number | FailureOutcome | null | void | string[];

let fixture: TwoTenantFixture;

const event = (over: Partial<FailureEvent> = {}): FailureEvent => ({
  tenantId: TENANT_A,
  sessionId: 's-1',
  tool: 'Bash',
  outcome: 'stored',
  rule: null,
  sigHash: null,
  detailHash: null,
  ...over,
});

function seed(dir: string): void {
  const log = sqliteSyncStore(dir).failureLog;
  log.record(event({ requestId: 'req-old', outcome: 'duplicate', now: '2025-10-01T00:00:00.000Z' }));
  log.record(event({ requestId: 'req-1', outcome: 'store-failed', now: '2026-02-28T00:00:00.000Z' }));
  log.record(event({ tenantId: TENANT_B, sessionId: 's-b', requestId: 'req-1', now: '2026-02-28T00:00:00.000Z' }));
  const lesson = (content: string, over: Parameters<typeof createMemory>[1], origin: string | null): void =>
    writeEntry(
      dir,
      { ...createMemory(content, { tenantId: TENANT_A, tags: ['error', TAG], ...over }), origin_project: origin },
      { actor: 'cli' },
    );
  lesson('lesson in proj', {}, 'proj');
  lesson('lesson for every project', {}, '');
  lesson('lesson in another project', {}, 'other');
  lesson('legacy-scoped lesson', { scope: 'unknown:legacy' }, 'proj');
  lesson('private lesson', { scope: 'team:Private:ops' }, 'proj');
  lesson('error without the tag', { tags: ['error', `${TAG}-x`] }, 'proj');
  lesson('lesson of tenant b', { tenantId: TENANT_B }, 'proj');
}

async function conforms<G extends 'failureLog' | 'lessonWrites'>(group: G, calls: readonly GroupCall<G, Value>[]) {
  const sides = await onBothStores(fixture, group, inMemoryFailureLogStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite.outcomes;
}

beforeAll(() => {
  fixture = seedTwoTenants();
  seed(fixture.dir);
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => vi.useRealTimers());

describe('FailureLog.requestOutcome', () => {
  it('answers the tenant own row, null for an unknown id, and refuses another session', async () => {
    const outcomes = await conforms('failureLog', [
      (g) => g.requestOutcome(TENANT_A, 'req-1', 's-1'),
      (g) => g.requestOutcome(TENANT_B, 'req-1', 's-b'),
      (g) => g.requestOutcome(TENANT_A, 'req-none', 's-1'),
      (g) => g.requestOutcome(TENANT_A, 'req-1', 's-other'),
    ]);
    expect(outcomes).toEqual([
      { value: 'store-failed' },
      { value: 'stored' },
      { value: null },
      { error: 'ConflictError: request id belongs to another session' },
    ]);
  });
});

describe('FailureLog.settleOutcome', () => {
  it('rewrites only the tenant own row, and an unknown id is a no-op', async () => {
    const outcomes = await conforms('failureLog', [
      (g) => g.settleOutcome(TENANT_A, 'req-1', 'stored'),
      (g) => g.settleOutcome(TENANT_A, 'req-none', 'stored'),
      (g) => g.requestOutcome(TENANT_A, 'req-1', 's-1'),
      (g) => g.requestOutcome(TENANT_B, 'req-1', 's-b'),
    ]);
    expect(outcomes.slice(2)).toEqual([{ value: 'stored' }, { value: 'stored' }]);
  });
});

describe('FailureLog.record', () => {
  it('answers the next id, prunes rows past retention and refuses a repeated request id', async () => {
    const outcomes = await conforms('failureLog', [
      (g) => g.record(event({ requestId: 'req-2', sessionId: 'x'.repeat(200) })),
      (g) => g.record(event({ requestId: null, sessionId: null })),
      (g) => g.requestOutcome(TENANT_A, 'req-2', 'x'.repeat(200)),
      (g) => g.requestOutcome(TENANT_A, 'req-old', 's-1'),
      (g) => g.record(event({ requestId: 'req-1' })),
    ]);
    expect(outcomes.slice(0, 4)).toEqual([{ value: 4 }, { value: 5 }, { value: 'stored' }, { value: null }]);
    expect(outcomes[4]).toHaveProperty('error');
  });
});

describe('LessonWrites.contentsWithTag', () => {
  const sorted = (rows: string[]): string[] => [...rows].sort();
  it('reads the tenant tagged rows the default scope admits, narrowed to the origins named', async () => {
    const outcomes = await conforms('lessonWrites', [
      (g) => g.contentsWithTag(TENANT_A, TAG).then(sorted),
      (g) => g.contentsWithTag(TENANT_A, TAG, ['proj']).then(sorted),
      (g) => g.contentsWithTag(TENANT_A, TAG, []).then(sorted),
      (g) => g.contentsWithTag(TENANT_B, TAG, ['proj']).then(sorted),
    ]);
    expect(outcomes).toEqual([
      { value: ['lesson for every project', 'lesson in another project', 'lesson in proj'] },
      { value: ['lesson for every project', 'lesson in proj'] },
      { value: ['lesson for every project'] },
      { value: ['lesson of tenant b'] },
    ]);
  });
});
