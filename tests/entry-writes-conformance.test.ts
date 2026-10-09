// EntryWrites answers alike on hippo.db and on a store held in memory: the same values, the same errors, the same rows read back
// and the same audit rows, over two tenants with personal, raw, summary and tombstoned rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { reject, type HippoDbContext } from '../src/api/index.js';
import { CHURN_STALE_TAG, type MemoryEntry } from '../src/core/memory.js';
import { writeEntry } from '../src/store/entry-writes.js';
import type { AuditEvent } from '../src/server.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { inMemoryEntryWritesStore } from './_helpers/in-memory-entry-writes-store.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:05.000Z';
const ALICE = 'personal:private:alice';
const BANNED = 'the launch date is march third';
const ACTOR = 'api_key:caller';

/** The columns these writes change, so a row compares across stores without the fields each store fills its own way. */
type Row = Pick<MemoryEntry, 'id' | 'tenantId' | 'kind' | 'scope' | 'content' | 'tags' | 'strength' | 'outcome_score' | 'outcome_positive'
  | 'outcome_negative' | 'superseded_by' | 'dag_parent_id' | 'summary_dirty' | 'origin_project'>;
type Value = string | string[] | Row[] | void;
type Call = GroupCall<'entryWrites', Value>;
type Side = SideResult<Value>;
interface Seeded {
  readonly note: MemoryEntry;
  readonly personal: MemoryEntry;
  readonly raw: MemoryEntry;
  readonly rawChild: MemoryEntry;
  readonly child: MemoryEntry;
  readonly summary: MemoryEntry;
  readonly churn: MemoryEntry;
  readonly noteB: MemoryEntry;
  readonly rawB: MemoryEntry;
}

let fixture: TwoTenantFixture;
let seeded: Seeded;
let baseline: Side;

function seed(dir: string): Seeded {
  const a = (content: string, extra: Parameters<typeof createMemory>[1] = {}): MemoryEntry => createMemory(content, { tenantId: TENANT_A, ...extra });
  const rows = {
    note: a('deploys go out on tuesdays'),
    personal: a('alice keeps her notes in the blue folder', { scope: ALICE }),
    raw: a('raw slack message about the outage', { kind: 'raw' }),
    churn: a('the build cache lives on the second disk', { tags: [CHURN_STALE_TAG, 'build'] }),
    noteB: createMemory('globex ships on fridays', { tenantId: TENANT_B }),
    rawB: createMemory('globex raw ticket text', { tenantId: TENANT_B, kind: 'raw' }),
  };
  const summary = a('summary of the release process', { dag_level: 2 });
  // The children go in first, so the summary starts clean.
  const child = a('release notes are drafted on mondays', { dag_parent_id: summary.id });
  const rawChild = a('raw standup transcript about releases', { kind: 'raw', dag_parent_id: summary.id });
  for (const entry of [...Object.values(rows), child, rawChild, summary]) writeEntry(dir, entry, { actor: 'cli' });
  const ctx: HippoDbContext = { hippoRoot: dir, tenantId: TENANT_A, actor: { subject: 'cli', role: 'admin' } };
  reject(ctx, { value: BANNED, reason: 'wrong date' });
  return { ...rows, summary, child, rawChild };
}

const project = (entries: MemoryEntry[]): Row[] => entries.map((e) => ({
  id: e.id, tenantId: e.tenantId, kind: e.kind, scope: e.scope, content: e.content, tags: e.tags, strength: e.strength,
  outcome_score: e.outcome_score, outcome_positive: e.outcome_positive, outcome_negative: e.outcome_negative,
  superseded_by: e.superseded_by, dag_parent_id: e.dag_parent_id, summary_dirty: e.summary_dirty, origin_project: e.origin_project,
}));

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'entryWrites', inMemoryEntryWritesStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

/** The audit rows a run added, without the ids and times both sides already matched on. */
const added = (side: Side): Omit<AuditEvent, 'id' | 'ts'>[] => side.audit.slice(baseline.audit.length).map(({ id: _id, ts, ...row }) => {
  expect(ts).toBe(NOW);
  return row;
});

const readBack = (tenantId: string, ...ids: string[]): Call => async (_g, store) => project(await store.entriesByIds(ids, tenantId));
const fresh = (content: string, extra: Parameters<typeof createMemory>[1] = {}): MemoryEntry =>
  ({ ...createMemory(content, { tenantId: TENANT_A, ...extra }), origin_project: 'proj' });
const target = (id: string, ownScope: string | null = null, tenantId = TENANT_A) => ({ tenantId, actor: ACTOR, ownScope, id });
const outcomeOn = (ids: string[], good: boolean, ownScope: string | null = null): Call => (g) => g.applyOutcome({ tenantId: TENANT_A, actor: ACTOR, ownScope, ids, good });
const supersede = (oldId: string, successor: MemoryEntry, ownScope: string | null = null): Call => async (g) => {
  await g.supersede({ tenantId: TENANT_A, actor: ACTOR, ownScope, oldId, successor });
};
const dirtied = (summary: MemoryEntry) => ({ tenantId: TENANT_A, actor: ACTOR, op: 'summary_marked_dirty', targetId: summary.id, metadata: { dag_level: 2, source: 'E2' } });
const remembered = (e: MemoryEntry) => ({ tenantId: e.tenantId, actor: ACTOR, op: 'remember', targetId: e.id, metadata: { kind: e.kind, scope: e.scope } });

beforeAll(async () => {
  fixture = seedTwoTenants();
  seeded = seed(fixture.dir);
  baseline = await conforms([]);
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EntryWrites.writeEntry', () => {
  it('writes a new row with one remember row', async () => {
    const entry = fresh('the on-call rota lives in the wiki');
    const side = await conforms([async (g) => { await g.writeEntry({ entry, actor: ACTOR }); }, readBack(TENANT_A, entry.id)]);
    expect(side.outcomes[1]).toEqual({ value: project([{ ...entry, summary_dirty: 0 }]) });
    expect(added(side)).toEqual([remembered(entry)]);
  });

  it('marks a clean summary parent dirty once, on the first child write only', async () => {
    const { summary } = seeded;
    const first = fresh('release branches are cut on wednesdays', { dag_parent_id: summary.id });
    const second = fresh('release tags are signed by the lead', { dag_parent_id: summary.id });
    const write = (entry: MemoryEntry): Call => async (g) => { await g.writeEntry({ entry, actor: ACTOR }); };
    const side = await conforms([write(first), write(second), readBack(TENANT_A, summary.id)]);
    // SAFETY: the third call reads rows back, so it resolved to Row[].
    expect((side.outcomes[2] as { value: Row[] }).value.map((r) => [r.id, r.summary_dirty])).toEqual([[summary.id, 1]]);
    expect(added(side)).toEqual([remembered(first), dirtied(summary), remembered(second)]);
  });

  it("refuses a tombstoned value in its tenant, writes a reject_refusal row, and lets another tenant store it", async () => {
    const banned = fresh(BANNED);
    const elsewhere = { ...fresh(BANNED), tenantId: TENANT_B };
    const side = await conforms([
      async (g) => { await g.writeEntry({ entry: banned, actor: ACTOR }); },
      async (g) => { await g.writeEntry({ entry: elsewhere, actor: ACTOR }); },
      readBack(TENANT_A, banned.id),
    ]);
    expect(side.outcomes[0]).toMatchObject({ error: expect.stringMatching(/^RejectedValueError: Memory value refused/) });
    expect(side.outcomes.slice(1)).toEqual([{ value: undefined }, { value: [] }]);
    const refusal = added(side)[0];
    expect(refusal).toMatchObject({ tenantId: TENANT_A, actor: ACTOR, op: 'reject_refusal', targetId: banned.id, metadata: { reason: 'wrong date' } });
    expect(added(side).slice(1)).toEqual([remembered(elsewhere)]);
  });

  it("refuses an id another tenant holds, leaving that tenant's row as it was and writing no audit row", async () => {
    const { noteB } = seeded;
    const taken = { ...fresh('acme now owns this row'), id: noteB.id };
    const side = await conforms([readBack(TENANT_B, noteB.id), async (g) => { await g.writeEntry({ entry: taken, actor: ACTOR }); }, readBack(TENANT_B, noteB.id)]);
    expect(side.outcomes[0]).toMatchObject({ value: [{ id: noteB.id, tenantId: TENANT_B, content: noteB.content }] });
    expect(side.outcomes[1]).toEqual({ error: `ConflictError: Memory ${noteB.id} belongs to another tenant` });
    expect(side.outcomes[2]).toEqual(side.outcomes[0]);
    expect(added(side)).toEqual([]);
  });
});

describe('EntryWrites.applyOutcome', () => {
  it('applies in order within reach, skips the rest, and builds a repeated id on its first outcome', async () => {
    const { note, personal, noteB } = seeded;
    const ids = [note.id, noteB.id, personal.id, 'mem_missing', note.id];
    const side = await conforms([outcomeOn(ids, true), outcomeOn([personal.id], false, ALICE), readBack(TENANT_A, note.id, personal.id)]);
    expect(side.outcomes.slice(0, 2)).toEqual([{ value: [note.id, note.id] }, { value: [personal.id] }]);
    // SAFETY: the third call reads rows back, so it resolved to Row[].
    const rows = (side.outcomes[2] as { value: Row[] }).value;
    const [n, p] = [rows.find((r) => r.id === note.id), rows.find((r) => r.id === personal.id)];
    expect([n?.outcome_positive, n?.outcome_score, p?.outcome_negative, p?.outcome_score]).toEqual([2, 1, 1, -1]);
    const outcomeRow = (id: string, good: boolean) => ({ tenantId: TENANT_A, actor: ACTOR, op: 'outcome', targetId: id, metadata: { good } });
    expect(added(side).filter((r) => r.op === 'outcome')).toEqual([outcomeRow(note.id, true), outcomeRow(note.id, true), outcomeRow(personal.id, false)]);
    expect(added(side).map((r) => r.op)).toEqual(['remember', 'outcome', 'remember', 'outcome', 'remember', 'outcome']);
  });

  it('drops the churn-stale tag on a good outcome only, and marks the summary of a child it rewrites', async () => {
    const { churn, child, summary } = seeded;
    const side = await conforms([outcomeOn([churn.id], false), readBack(TENANT_A, churn.id), outcomeOn([churn.id, child.id], true), readBack(TENANT_A, churn.id)]);
    // SAFETY: the second and fourth calls read rows back, so each resolved to Row[].
    const tagsAt = (i: number) => (side.outcomes[i] as { value: Row[] }).value[0]?.tags;
    expect([tagsAt(1), tagsAt(3)]).toEqual([[CHURN_STALE_TAG, 'build'], ['build']]);
    expect(added(side).filter((r) => r.op === 'summary_marked_dirty')).toEqual([dirtied(summary)]);
  });
});

describe('EntryWrites.supersede', () => {
  it("chains the old row to its successor and marks the old row's summary, then refuses a second supersede", async () => {
    const { child, summary } = seeded;
    const next = fresh('release notes are drafted on tuesdays now');
    const again = fresh('release notes are drafted on fridays');
    const side = await conforms([supersede(child.id, next), supersede(child.id, again), readBack(TENANT_A, child.id, again.id)]);
    expect(side.outcomes.slice(0, 2)).toEqual([{ value: undefined }, { error: `ConflictError: Memory ${child.id} already superseded by another writer` }]);
    // SAFETY: the third call reads rows back, so it resolved to Row[].
    expect((side.outcomes[2] as { value: Row[] }).value.map((r) => [r.id, r.superseded_by])).toEqual([[child.id, next.id]]);
    expect(added(side)).toEqual([
      dirtied(summary), remembered(next), { tenantId: TENANT_A, actor: ACTOR, op: 'supersede', targetId: child.id, metadata: { newId: next.id } },
    ]);
  });

  it('answers a row out of reach as not found and writes nothing', async () => {
    const { personal, noteB } = seeded;
    const [b, p] = [fresh('globex ships on mondays'), fresh('alice keeps her notes in the red folder')];
    const side = await conforms([supersede(noteB.id, b), supersede(personal.id, p), readBack(TENANT_A, personal.id, b.id, p.id), readBack(TENANT_B, noteB.id)]);
    expect(side.outcomes.slice(0, 2)).toEqual([{ error: `NotFoundError: memory not found: ${noteB.id}` }, { error: `NotFoundError: memory not found: ${personal.id}` }]);
    // SAFETY: the last two calls read rows back, so each resolved to Row[].
    const chains = (i: number) => (side.outcomes[i] as { value: Row[] }).value.map((r) => [r.id, r.superseded_by]);
    expect([chains(2), chains(3)]).toEqual([[[personal.id, null]], [[noteB.id, null]]]);
    expect(added(side)).toEqual([]);
  });

  it('rolls back a tombstoned successor whole, keeping only the refusal row', async () => {
    const { note } = seeded;
    const banned = fresh(BANNED);
    const side = await conforms([supersede(note.id, banned), readBack(TENANT_A, note.id, banned.id)]);
    expect(side.outcomes[0]).toMatchObject({ error: expect.stringMatching(/^RejectedValueError: /) });
    // SAFETY: the second call reads rows back, so it resolved to Row[].
    expect((side.outcomes[1] as { value: Row[] }).value.map((r) => [r.id, r.superseded_by])).toEqual([[note.id, null]]);
    expect(added(side).map((r) => [r.op, r.targetId])).toEqual([['reject_refusal', banned.id]]);
  });
});

describe('EntryWrites.archiveRaw', () => {
  it('archives a raw row at the time it returns, with one archive_raw row, and marks its summary', async () => {
    const { rawChild, summary } = seeded;
    const side = await conforms([(g) => g.archiveRaw({ ...target(rawChild.id), reason: 'source deleted' }), readBack(TENANT_A, rawChild.id)]);
    expect(side.outcomes).toEqual([{ value: NOW }, { value: [] }]);
    expect(added(side)).toEqual([
      { tenantId: TENANT_A, actor: ACTOR, op: 'archive_raw', targetId: rawChild.id, metadata: { reason: 'source deleted' } }, dirtied(summary),
    ]);
  });

  it("answers a row out of reach as not found and refuses a row that is not raw, writing nothing", async () => {
    const { note, personal, rawB } = seeded;
    const archive = (id: string, ownScope: string | null = null): Call => (g) => g.archiveRaw({ ...target(id, ownScope), reason: 'r' });
    const side = await conforms([archive(rawB.id), archive(personal.id), archive('mem_missing'), archive(note.id), archive(personal.id, ALICE)]);
    expect(side.outcomes).toEqual([
      { error: `NotFoundError: memory not found: ${rawB.id}` },
      { error: `NotFoundError: memory not found: ${personal.id}` },
      { error: 'NotFoundError: memory not found: mem_missing' },
      { error: `BadRequestError: memory ${note.id} is not raw (kind=distilled)` },
      { error: `BadRequestError: memory ${personal.id} is not raw (kind=distilled)` },
    ]);
    expect(added(side)).toEqual([]);
  });
});

describe('EntryWrites.forget', () => {
  it('deletes a row with one forget row and marks its summary', async () => {
    const { child, summary } = seeded;
    const side = await conforms([(g) => g.forget(target(child.id)), readBack(TENANT_A, child.id)]);
    expect(side.outcomes).toEqual([{ value: undefined }, { value: [] }]);
    expect(added(side)).toEqual([{ tenantId: TENANT_A, actor: ACTOR, op: 'forget', targetId: child.id, metadata: {} }, dirtied(summary)]);
  });

  it('keeps a raw row, as raw is append-only, and answers a row out of reach as not found', async () => {
    const { raw, personal, noteB } = seeded;
    const forget = (id: string, ownScope: string | null = null): Call => (g) => g.forget(target(id, ownScope));
    const side = await conforms([forget(raw.id), forget(noteB.id), forget(personal.id), forget(personal.id, ALICE), readBack(TENANT_A, raw.id, personal.id)]);
    expect(side.outcomes.slice(0, 4)).toEqual([
      { error: 'Error: raw is append-only' },
      { error: `NotFoundError: memory not found: ${noteB.id}` },
      { error: `NotFoundError: memory not found: ${personal.id}` },
      { value: undefined },
    ]);
    // SAFETY: the fifth call reads rows back, so it resolved to Row[].
    expect((side.outcomes[4] as { value: Row[] }).value.map((r) => r.id)).toEqual([raw.id]);
    expect(added(side).map((r) => [r.op, r.targetId])).toEqual([['forget', personal.id]]);
  });
});
