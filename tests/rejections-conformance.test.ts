// Rejections answers alike on hippo.db and on a store held in memory: the same removals, tombstones, refusals and audit rows,
// over two tenants holding the same text.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { MemoryEntry } from '../src/core/memory.js';
import type { AppliedRejection, AuditEvent, LiftedRejection, RejectedValueRow, Rejection } from '../src/entry/store-kit.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { inMemoryRejectionsStore } from './_helpers/in-memory-rejections-store.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:05.000Z';
const ACTOR = 'api_key:caller';
const SHARED = 'the launch date is march third';

type Row = Pick<MemoryEntry, 'id' | 'tenant_id' | 'kind' | 'content' | 'summary_dirty'>;
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
}

let fixture: TwoTenantFixture;
let seeded: Seeded;
let baseline: Side;

function seed(dir: string): Seeded {
  const a = (content: string, extra: Parameters<typeof createMemory>[1] = {}): MemoryEntry => createMemory(content, { tenantId: TENANT_A, ...extra });
  const summary = a('summary of the launch plan', { dagLevel: 2 });
  const note = a(SHARED);
  // A second later, since removal runs oldest first and two rows of one millisecond fall back to their random ids.
  const copy = { ...a('The Launch date is  MARCH third'), created: new Date(Date.parse(note.created) + 1000).toISOString() };
  const rows = {
    note,
    copy,
    raw: a('raw slack line: deploy freeze starts friday', { kind: 'raw' }),
    merged: a('Merged notes\n\n- the office moves in june\n- badges are reissued in july', { source: 'consolidation' }),
    child: a('launch comms are drafted by marketing', { dagParentId: summary.id }),
    noteB: createMemory(SHARED, { tenantId: TENANT_B }),
  };
  for (const entry of [...Object.values(rows), summary]) writeEntry(dir, { ...entry, origin_project: 'proj' }, { actor: 'cli' });
  return { ...rows, summary };
}

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'rejections', inMemoryRejectionsStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

const added = (side: Side): Omit<AuditEvent, 'id' | 'ts'>[] => side.audit.slice(baseline.audit.length).map(({ id: _id, ts: _ts, ...row }) => row);
const rejection = (over: Partial<Rejection> & Pick<Rejection, 'textOf'>, tenantId = TENANT_A): Rejection =>
  ({ tenantId, actor: ACTOR, reason: 'wrong', inReach: () => true, successorOf: () => undefined, ...over });
const byText = (text: string, tenantId = TENANT_A): Call => (g) => g.apply(rejection({ textOf: () => text }, tenantId));
const readBack = (tenantId: string, ...ids: string[]): Call => async (_g, store) =>
  (await store.entriesByIds(ids, tenantId)).map((e) => ({ id: e.id, tenant_id: e.tenant_id, kind: e.kind, content: e.content, summary_dirty: e.summary_dirty }));
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
      (g) => g.apply(rejection({ memoryId: note.id, textOf: (source) => source?.content ?? '' })),
      readBack(TENANT_A, note.id, copy.id),
      readBack(TENANT_B, noteB.id),
    ]);
    expect(value<AppliedRejection>(side, 0)).toMatchObject({ content: SHARED, removedIds: [note.id, copy.id], removedRawIds: [] });
    expect(value<Row[]>(side, 1)).toEqual([]);
    expect(value<Row[]>(side, 2).map((r) => r.id)).toEqual([noteB.id]);
    expect(added(side).map((r) => r.op)).toEqual(['reject_value']);
  });

  it('archives a raw row and marks a removed child summary dirty', async () => {
    const { raw, child, summary } = seeded;
    const side = await conforms([byText(raw.content), byText(child.content), readBack(TENANT_A, summary.id)]);
    expect(value<AppliedRejection>(side, 0).removedRawIds).toEqual([raw.id]);
    expect(value<Row[]>(side, 2)[0]?.summary_dirty).toBe(true);
    expect(added(side).map((r) => r.op)).toEqual(['archive_raw', 'reject_value', 'summary_marked_dirty', 'reject_value']);
  });

  it('replaces a merged row holding the text with the successor its policy names', async () => {
    const { merged } = seeded;
    const successor = { ...createMemory('badges are reissued in july', { tenantId: TENANT_A }), origin_project: 'proj' };
    const side = await conforms([
      (g) => g.apply(rejection({ textOf: () => 'the office moves in june', successorOf: (row) => (row.id === merged.id ? successor : undefined) })),
      readBack(TENANT_A, merged.id, successor.id),
    ]);
    expect(value<AppliedRejection>(side, 0)).toMatchObject({ removedIds: [merged.id], successorIds: [successor.id] });
    expect(value<Row[]>(side, 1).map((r) => r.id)).toEqual([successor.id]);
  });

  it('writes nothing when textOf refuses, and leaves a row its policy puts out of reach', async () => {
    const { note } = seeded;
    const side = await conforms([
      (g) => g.apply(rejection({ textOf: () => { throw new Error('refused'); } })),
      (g) => g.apply(rejection({ textOf: () => note.content, inReach: () => false })),
      readBack(TENANT_A, note.id),
    ]);
    expect(side.outcomes[0]).toEqual({ error: 'Error: refused' });
    expect(value<AppliedRejection>(side, 1).removedIds).toEqual([]);
    expect(value<Row[]>(side, 2).map((r) => r.id)).toEqual([note.id]);
  });
});

describe('Rejections.list, lift and refusedAmong', () => {
  it('lists per tenant, lifts one match by prefix, and writes nothing for an ambiguous prefix', async () => {
    const side = await conforms([
      byText('first value'), byText('second value'), byText('first value', TENANT_B),
      (g) => g.list(TENANT_A), (g) => g.lift(TENANT_A, '', ACTOR), (g) => g.lift(TENANT_B, 'zz', ACTOR),
    ]);
    const digest = value<AppliedRejection>(side, 2).digest;
    const lift = await conforms([
      byText('first value', TENANT_B), (g) => g.lift(TENANT_B, digest.slice(0, 10), ACTOR), (g) => g.list(TENANT_B),
    ]);
    expect(value<RejectedValueRow[]>(side, 3)).toHaveLength(2);
    expect(value<LiftedRejection>(side, 4).status).toBe('ambiguous');
    expect(value<LiftedRejection>(side, 5)).toEqual({ status: 'not_found' });
    expect(value<LiftedRejection>(lift, 1)).toEqual({ status: 'ok', digest, reason: 'wrong' });
    expect(value<RejectedValueRow[]>(lift, 2)).toEqual([]);
    expect(added(lift).map((r) => r.op)).toEqual(['reject_value', 'unreject_value']);
  });

  it("refuses the tombstoned text for a new id in its tenant only, and passes the row that already holds it", async () => {
    const { note } = seeded;
    const side = await conforms([
      (g) => g.apply(rejection({ textOf: () => SHARED, inReach: () => false })),
      (g) => g.refusedAmong([
        { tenantId: TENANT_A, entryId: 'mem_new', content: 'The launch date is march THIRD' },
        { tenantId: TENANT_A, entryId: note.id, content: SHARED },
        { tenantId: TENANT_B, entryId: 'mem_new', content: SHARED },
      ]),
    ]);
    expect(value<boolean[]>(side, 1)).toEqual([true, false, false]);
    expect(added(side).map((r) => r.op)).toEqual(['reject_value']);
  });
});
