// The row checks: every entryWrites write, and the base reads that find rows by query, id, filter
// and freshness.
import { BadRequestError, ConflictError } from '../../base/errors/api-errors.js';
import type { RecallSearchArgs } from '../../base/ports/store/recall-writes.js';
import {
  ACTOR,
  ADMIN,
  OTHER_TENANT,
  TENANT,
  failureOf,
  idsOf,
  rowOf,
  writeRows,
  type Check,
} from './kit.js';

const SEARCH: RecallSearchArgs = {
  limit: 10,
  tenantId: TENANT,
  explicitScopeMode: 'exact',
  includeSuperseded: false,
  ownScope: undefined,
};

const writesAndFences: Check = async (store, expect) => {
  const row = rowOf(TENANT, 'the deploy runs nightly', 1);
  await writeRows(store, [row]);
  expect((await store.entriesByIds([row.id], TENANT)).map((e) => e.content)).toEqual([row.content]);
  expect(await store.entriesByIds([row.id], OTHER_TENANT)).toEqual([]);
  const taken = { ...rowOf(OTHER_TENANT, 'another tenant', 2), id: row.id };
  const failure = await failureOf(() =>
    store.entryWrites.writeEntry({ entry: taken, actor: ACTOR }),
  );
  expect(failure?.startsWith(`${ConflictError.name}:`)).toBe(true);
};

const appliesOutcomeAndPins: Check = async (store, expect) => {
  const row = rowOf(TENANT, 'retry the flaky test once', 1);
  await writeRows(store, [row]);
  const outcome = { ...ADMIN, ids: [row.id, 'mem_none'], good: true };
  expect(await store.entryWrites.applyOutcome(outcome)).toEqual([row.id]);
  const [after] = await store.entriesByIds([row.id], TENANT);
  expect(after?.outcomePositive).toBe(1);
  expect((await store.entryWrites.setPinned({ ...ADMIN, id: row.id, pinned: true })).pinned).toBe(
    true,
  );
};

const supersedesOnce: Check = async (store, expect) => {
  const old = rowOf(TENANT, 'deploys go out on fridays', 1);
  const successor = rowOf(TENANT, 'deploys go out on tuesdays', 2);
  await writeRows(store, [old]);
  await store.entryWrites.supersede({ ...ADMIN, oldId: old.id, successor });
  const rows = await store.entriesByIds([old.id, successor.id], TENANT);
  expect(rows.map((e) => [e.id, e.supersededBy])).toEqual([
    [old.id, successor.id],
    [successor.id, null],
  ]);
  const again = rowOf(TENANT, 'deploys go out on mondays', 3);
  const failure = await failureOf(() =>
    store.entryWrites.supersede({ ...ADMIN, oldId: old.id, successor: again }),
  );
  expect(failure?.startsWith(`${ConflictError.name}:`)).toBe(true);
};

const archivesRawOnly: Check = async (store, expect) => {
  const raw = rowOf(TENANT, 'raw: standup notes', 1, { kind: 'raw' });
  const distilled = rowOf(TENANT, 'standups are at ten', 2);
  await writeRows(store, [raw, distilled]);
  const archivedAt = await store.entryWrites.archiveRaw({
    ...ADMIN,
    id: raw.id,
    reason: 'conformance',
  });
  expect(Number.isNaN(Date.parse(archivedAt))).toBe(false);
  expect(await store.entriesByIds([raw.id], TENANT)).toEqual([]);
  const failure = await failureOf(() =>
    store.entryWrites.archiveRaw({ ...ADMIN, id: distilled.id, reason: 'conformance' }),
  );
  expect(failure?.startsWith(`${BadRequestError.name}:`)).toBe(true);
};

const forgetsAllButRaw: Check = async (store, expect) => {
  const row = rowOf(TENANT, 'the old cache host', 1);
  const raw = rowOf(TENANT, 'raw: kept as said', 2, { kind: 'raw' });
  await writeRows(store, [row, raw]);
  await store.entryWrites.forget({ ...ADMIN, id: row.id });
  expect(await store.entriesByIds([row.id], TENANT)).toEqual([]);
  const failure = await failureOf(() => store.entryWrites.forget({ ...ADMIN, id: raw.id }));
  expect(failure?.endsWith('raw is append-only')).toBe(true);
  expect(idsOf(await store.entriesByIds([raw.id], TENANT))).toEqual([raw.id]);
};

export const ENTRY_WRITE_CHECKS = {
  'writes a row its tenant reads back, and refuses an id another tenant holds': writesAndFences,
  'applies an outcome to the ids it finds, and pins a row': appliesOutcomeAndPins,
  'supersedes a row with its successor, once': supersedesOnce,
  'archives a raw row and refuses to archive any other kind': archivesRawOnly,
  'forgets a row and refuses to forget a raw one': forgetsAllButRaw,
} satisfies Readonly<Record<string, Check>>;

/** Two rows of `TENANT`, one of the other tenant, and two raw rows of `TENANT`, the newer in session s1. */
function readRows() {
  return {
    deploy: rowOf(TENANT, 'the deploy pipeline runs nightly', 1),
    cache: rowOf(TENANT, 'the cache lives in redis', 2),
    theirs: rowOf(OTHER_TENANT, 'their deploy runs weekly', 3),
    rawOld: rowOf(TENANT, 'raw: standup said the deploy slipped', 4, { kind: 'raw' }),
    rawNew: rowOf(TENANT, 'raw: standup in session s1', 5, { kind: 'raw', sourceSessionId: 's1' }),
  };
}

const searchesTenant: Check = async (store, expect) => {
  const rows = readRows();
  await writeRows(store, Object.values(rows));
  const found = await store.searchRecallEntries('pipeline', SEARCH);
  expect(found[0]?.id).toBe(rows.deploy.id);
  expect(found.some((e) => e.tenantId !== TENANT)).toBe(false);
};

const readsByIds: Check = async (store, expect) => {
  const rows = readRows();
  const { deploy, cache, theirs } = rows;
  await writeRows(store, Object.values(rows));
  const ids = [cache.id, 'mem_none', theirs.id, deploy.id, cache.id];
  expect(idsOf(await store.entriesByIds(ids, TENANT))).toEqual([deploy.id, cache.id]);
};

const pagesFilter: Check = async (store, expect) => {
  const rows = readRows();
  await writeRows(store, Object.values(rows));
  const filter = { tenantId: TENANT, kinds: ['raw' as const] };
  const first = await store.entriesWhere(filter, { limit: 1 });
  expect(idsOf(first.entries)).toEqual([rows.rawOld.id]);
  const next = first.next ?? undefined;
  expect(next === undefined).toBe(false);
  expect(idsOf((await store.entriesWhere(filter, { limit: 1, after: next })).entries)).toEqual([
    rows.rawNew.id,
  ]);
};

const readsFreshRaw: Check = async (store, expect) => {
  const rows = readRows();
  const { rawOld, rawNew } = rows;
  await writeRows(store, Object.values(rows));
  expect(idsOf(await store.freshRawEntries(10, TENANT, undefined, null))).toEqual([
    rawNew.id,
    rawOld.id,
  ]);
  expect(idsOf(await store.freshRawEntries(10, TENANT, 's1', null))).toEqual([rawNew.id]);
  expect(idsOf(await store.freshRawEntries(10, OTHER_TENANT, undefined, null))).toEqual([]);
};

export const BASE_READ_CHECKS = {
  "searches a tenant's rows with whole-word matches first": searchesTenant,
  "reads a tenant's rows by id in created order, skipping ids it lacks": readsByIds,
  'pages the rows a filter keeps by created, then id': pagesFilter,
  "reads a tenant's newest raw rows first, narrowed to a session when one is named": readsFreshRaw,
} satisfies Readonly<Record<string, Check>>;
