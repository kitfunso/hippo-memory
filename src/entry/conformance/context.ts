// The context checks: the candidate rows, the ambient load and tallies, and schema fit.
import { OTHER_TENANT, TENANT, idsOf, rowOf, writeRows, type Check } from './kit.js';

/** A pinned and a plain row of `TENANT`, one of the other tenant, and a time just after them. */
function contextRows() {
  const pinned = rowOf(TENANT, 'always run the linter before a push', 1, { pinned: true });
  const plain = rowOf(TENANT, 'the linter config lives in the repo root', 2);
  const theirs = rowOf(OTHER_TENANT, 'their linter is stricter', 3);
  return {
    pinned,
    plain,
    rows: [pinned, plain, theirs],
    now: new Date(Date.parse(plain.created) + 60_000),
  };
}

const readsCandidates: Check = async (store, expect) => {
  const { pinned, plain, rows, now } = contextRows();
  await writeRows(store, rows);
  const all = await store.contextReads.contextCandidates(TENANT, { cap: 10, now });
  expect(idsOf(all)).toEqual([pinned.id, plain.id]);
  const capped = await store.contextReads.contextCandidates(TENANT, { cap: 1, now });
  expect(idsOf(capped)).toEqual([pinned.id]);
};

const loadsAmbient: Check = async (store, expect) => {
  const { pinned, rows } = contextRows();
  await writeRows(store, rows);
  const admit = { currentProject: 'proj', includeCrossProject: false };
  const loaded = await store.contextReads.ambientCandidates(TENANT, { recentNeeded: 5, admit });
  expect(loaded.entries.some((e) => e.id === pinned.id)).toBe(true);
  expect(loaded.entries.some((e) => e.tenantId !== TENANT)).toBe(false);
};

const talliesAndFit: Check = async (store, expect) => {
  const { rows, now } = contextRows();
  await writeRows(store, rows);
  const tallies = await store.contextReads.ambientTallies(TENANT, {
    currentProject: ['proj'],
    now,
  });
  expect(tallies.total).toBe(2);
  const fit = await store.contextReads.schemaFit(TENANT, 'the linter runs on push', ['ci']);
  expect(fit >= 0 && fit <= 1).toBe(true);
};

export const CONTEXT_READ_CHECKS = {
  "reads a tenant's context candidates, at most the cap": readsCandidates,
  "loads a tenant's pins and recent rows as ambient candidates": loadsAmbient,
  "tallies a tenant's live rows and scores schema fit between 0 and 1": talliesAndFit,
} satisfies Readonly<Record<string, Check>>;
