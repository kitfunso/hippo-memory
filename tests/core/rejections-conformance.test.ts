// Rejections answers alike on hippo.db and on a store held in memory: the same removals, tombstones, refusals and audit rows,
// over two tenants holding the same text.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../../src/base/memory/memory.js';
import type {
  AppliedRejection,
  AuditEvent,
  LiftedRejection,
  RejectedValueRow,
  Rejection,
} from '../../src/entry/store-kit.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { inMemoryRejectionsStore } from '../_helpers/in-memory-rejections-store.js';
import {
  onBothStores,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
  type GroupCall,
  type SideResult,
  type TwoTenantFixture,
} from '../_helpers/store-conformance.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const NOW = '2026-03-01T12:00:05.000Z';
const ACTOR = 'api_key:caller';
const SHARED = 'the launch date is march third';
const ALICE = 'personal:private:alice';

type Row = Pick<MemoryEntry, 'id' | 'tenantId' | 'kind' | 'content' | 'summaryDirty'>;
type Value = AppliedRejection | LiftedRejection | RejectedValueRow[] | boolean[] | Row[];
type Call = GroupCall<'rejections', Value>;
type Side = SideResult<Value>;

interface Seeded {
  readonly note: MemoryEntry;
  readonly copy: MemoryEntry;
  readonly raw: MemoryEntry;
  readonly merged: MemoryEntry;
  readonly child: MemoryEntry;
  readonly summary: MemoryEntry;
  readonly noteB: MemoryEntry;
  readonly own: MemoryEntry;
}

let fixture: TwoTenantFixture;
let seeded: Seeded;
let baseline: Side;

function seed(dir: string): Seeded {
  const a = (content: string, extra: Parameters<typeof createMemory>[1] = {}): MemoryEntry =>
    createMemory(content, { tenantId: TENANT_A, ...extra });
  const summary = a('summary of the launch plan', { dagLevel: 2 });
  const note = a(SHARED);
  // A second later, since removal runs oldest first and two rows of one millisecond fall back to their random ids.
  const copy = {
    ...a('The Launch date is  MARCH third'),
    created: new Date(Date.parse(note.created) + 1000).toISOString(),
  };
  const rows = {
    note,
    copy,
    raw: a('raw slack line: deploy freeze starts friday', { kind: 'raw' }),
    merged: a('Merged notes\n\n- the office moves in june\n- badges are reissued in july', { source: 'consolidation' }),
    child: a('launch comms are drafted by marketing', { dagParentId: summary.id }),
    noteB: createMemory(SHARED, { tenantId: TENANT_B }),
    own: a('my parking spot is level three', { scope: ALICE }),
  };
  for (const entry of [...Object.values(rows), summary]) {
    writeEntry(dir, { ...entry, originProject: 'proj' }, { actor: 'cli' });
  }
  return { ...rows, summary };
}

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'rejections', inMemoryRejectionsStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

const added = (side: Side): Omit<AuditEvent, 'id' | 'ts'>[] =>
  side.audit.slice(baseline.audit.length).map(({ id: _id, ts: _ts, ...row }) => row);
const rejection = (over: Partial<Rejection>, tenantId = TENANT_A): Rejection => ({
  tenantId,
  actor: ACTOR,
  reason: 'wrong',
  ownScope: null,
  ...over,
});
const byText =
  (text: string, tenantId = TENANT_A): Call =>
  (g) =>
    g.apply(rejection({ value: text }, tenantId));
const readBack =
  (tenantId: string, ...ids: string[]): Call =>
  async (_g, store) =>
    (await store.entriesByIds(ids, tenantId)).map((e) => ({
      id: e.id,
      tenantId: e.tenantId,
      kind: e.kind,
      content: e.content,
      summaryDirty: e.summaryDirty,
    }));
const value = <T extends Value>(side: Side, i: number): T => {
  const outcome = side.outcomes[i];
  if (outcome === undefined || !('value' in outcome)) throw new Error(`call ${i} did not resolve`);
  // SAFETY: the caller names the call whose value type it reads.
  return outcome.value as T;
};

beforeAll(async () => {
  fixture = seedTwoTenants();
  seeded = seed(fixture.dir);
  baseline = await conforms([]);
});

afterAll(() => rmSync(fixture.dir, { recursive: true, force: true }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => vi.useRealTimers());

describe('Rejections.apply', () => {
  it('removes every same-digest row in the tenant, leaves the other tenant, and writes one reject_value row', async () => {
    const { note, copy, noteB } = seeded;
    const side = await conforms([
      (g) => g.apply(rejection({ memoryId: note.id })),
      readBack(TENANT_A, note.id, copy.id),
      readBack(TENANT_B, noteB.id),
    ]);
    expect(value<AppliedRejection>(side, 0)).toMatchObject({
      content: SHARED,
      removedIds: [note.id, copy.id],
      removedRawIds: [],
    });
    expect(value<Row[]>(side, 1)).toEqual([]);
    expect(value<Row[]>(side, 2).map((r) => r.id)).toEqual([noteB.id]);
    expect(added(side).map((r) => r.op)).toEqual(['reject_value']);
  });

  it('archives a raw row and marks a removed child summary dirty', async () => {
    const { raw, child, summary } = seeded;
    const side = await conforms([byText(raw.content), byText(child.content), readBack(TENANT_A, summary.id)]);
    expect(value<AppliedRejection>(side, 0).removedRawIds).toEqual([raw.id]);
    expect(value<Row[]>(side, 2)[0]?.summaryDirty).toBe(true);
    expect(added(side).map((r) => r.op)).toEqual([
      'archive_raw',
      'reject_value',
      'summary_marked_dirty',
      'reject_value',
    ]);
  });

  it('replaces a merged row holding the text with the successor built from its other texts', async () => {
    const { merged } = seeded;
    const sides = await onBothStores(fixture, 'rejections', inMemoryRejectionsStore, [
      async (g, store) => {
        const applied = await g.apply(rejection({ value: 'the office moves in june' }));
        const rows = await store.entriesByIds([merged.id, ...applied.successorIds], TENANT_A);
        // A successor gets a fresh id as a new merge does, so the two sides compare it by its text.
        return rows.map((r) => ({
          id: r.id === merged.id ? r.id : 'successor',
          tenantId: r.tenantId,
          kind: r.kind,
          content: r.content,
          summaryDirty: r.summaryDirty,
        }));
      },
    ]);
    expect(sides.other.outcomes).toEqual(sides.sqlite.outcomes);
    expect(sides.other.audit.map((r) => r.op)).toEqual(sides.sqlite.audit.map((r) => r.op));
    const rows = value<Row[]>(sides.sqlite, 0);
    expect(rows.map((r) => r.id)).toEqual(['successor']);
    expect(rows[0]?.content).toContain('badges are reissued in july');
    expect(rows[0]?.content).not.toContain('the office moves in june');
  });

  it("writes nothing for a rejection naming no text, and leaves another person's personal row", async () => {
    const { own } = seeded;
    const side = await conforms([
      (g) => g.apply(rejection({})),
      (g) => g.apply(rejection({ value: own.content })),
      readBack(TENANT_A, own.id),
      (g) => g.apply(rejection({ value: own.content, ownScope: ALICE })),
      readBack(TENANT_A, own.id),
    ]);
    expect(side.outcomes[0]).toMatchObject({ error: expect.stringContaining('reject requires either a memory id') });
    expect(value<AppliedRejection>(side, 1).removedIds).toEqual([]);
    expect(value<Row[]>(side, 2).map((r) => r.id)).toEqual([own.id]);
    expect(value<AppliedRejection>(side, 3).removedIds).toEqual([own.id]);
    expect(value<Row[]>(side, 4)).toEqual([]);
  });

  it('refuses a personal row and a row of another tenant named by id, before any write', async () => {
    const { own, noteB } = seeded;
    const side = await conforms([
      (g) => g.apply(rejection({ memoryId: own.id })),
      (g) => g.apply(rejection({ memoryId: noteB.id })),
    ]);
    expect(side.outcomes[0]).toMatchObject({ error: expect.stringContaining("Personal memories can't be rejected") });
    expect(side.outcomes[1]).toMatchObject({ error: `Error: memory not found: ${noteB.id}` });
    expect(added(side)).toEqual([]);
  });
});

describe('Rejections.list, lift and refusedAmong', () => {
  it('lists per tenant, lifts one match by prefix, and writes nothing for an ambiguous prefix', async () => {
    const side = await conforms([
      byText('first value'),
      byText('second value'),
      byText('first value', TENANT_B),
      (g) => g.list(TENANT_A),
      (g) => g.lift(TENANT_A, '', ACTOR),
      (g) => g.lift(TENANT_B, 'zz', ACTOR),
    ]);
    const digest = value<AppliedRejection>(side, 2).digest;
    const lift = await conforms([
      byText('first value', TENANT_B),
      (g) => g.lift(TENANT_B, digest.slice(0, 10), ACTOR),
      (g) => g.list(TENANT_B),
    ]);
    expect(value<RejectedValueRow[]>(side, 3)).toHaveLength(2);
    expect(value<LiftedRejection>(side, 4).status).toBe('ambiguous');
    expect(value<LiftedRejection>(side, 5)).toEqual({ status: 'not_found' });
    expect(value<LiftedRejection>(lift, 1)).toEqual({ status: 'ok', digest, reason: 'wrong' });
    expect(value<RejectedValueRow[]>(lift, 2)).toEqual([]);
    expect(added(lift).map((r) => r.op)).toEqual(['reject_value', 'unreject_value']);
  });

  it('refuses the tombstoned text for a new id in its tenant only, and passes the row that already holds it', async () => {
    const { own } = seeded;
    const side = await conforms([
      (g) => g.apply(rejection({ value: own.content })),
      (g) =>
        g.refusedAmong([
          { tenantId: TENANT_A, entryId: 'mem_new', content: 'My parking spot is LEVEL three' },
          { tenantId: TENANT_A, entryId: own.id, content: own.content },
          { tenantId: TENANT_B, entryId: 'mem_new', content: own.content },
        ]),
    ]);
    expect(value<boolean[]>(side, 1)).toEqual([true, false, false]);
    expect(added(side).map((r) => r.op)).toEqual(['reject_value']);
  });
});
