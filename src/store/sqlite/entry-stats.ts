// hippo.db's per-row stat writes: retrieval strength, tags, half-lives and the in-transaction delete.
import { type MemoryEntry, markRetrieved } from '../../base/memory/entry.js';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  openHippoDb,
  withWriteScope,
} from '../../db/index.js';
import { rethrowIfStoreBlocked } from '../../base/util/store-blocked.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import { readEntriesByIds } from './entry-reads.js';
import { syncFtsRow, deleteFtsRow } from './entry-row.js';
import type { StoreModel } from './open.js';
import { bindHandleClock } from './handle-clock.js';
import type { StrengthenOptions } from '../../base/ports/store/recall-writes.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** No ids, or a run that ablates the recall boost: nothing to strengthen, so no handle opens and
 * no scope starts. */
function strengthensNothing(ids: readonly string[], opts: StrengthenOptions): boolean {
  return ids.length === 0 || opts.recallBoostAblated;
}

/** strengthenRetrieved on an open handle in its own write scope, a savepoint inside a caller's
 * transaction, so a recall's last writes share one handle. */
export function strengthenRetrievedInOwnTx(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  if (strengthensNothing(ids, opts)) return new Set();
  try {
    return withWriteScope(db, 'strengthen_retrieved', () =>
      strengthenRetrievedOn(db, ids, opts, rules),
    );
  } catch (error) {
    warnStrengthenFailed(error);
    return new Set();
  }
}

function warnStrengthenFailed<E>(error: E): void {
  log.warn(`retrieval stats not saved (${errorMessage(error)})`, errorFields(error));
}

/** Strengthen what a recall returned from the global store, on a handle of its own: only the
 * four retrieval columns of the live row change. Best effort: a failure logs and never fails the
 * read. Returns the ids found there. */
export function strengthenRetrieved(
  hippoRoot: string,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  if (strengthensNothing(ids, opts)) return new Set();
  let db: DatabaseSyncLike;
  try {
    db = bindHandleClock(openHippoDb(hippoRoot), rules.clock);
  } catch (error) {
    rethrowIfStoreBlocked(error);
    warnStrengthenFailed(error);
    return new Set();
  }
  try {
    return strengthenRetrievedInOwnTx(db, ids, opts, rules);
  } finally {
    closeHippoDb(db);
  }
}

// One statement text for any number of rows. Numbers round-trip through JSON exactly from 1e-80 up;
// only the cached strength of a long-decayed wrong memory falls below, and that one may land a unit
// in the last place off.
const RETRIEVAL_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS rc, ` +
  `json_extract(value, '$[2]') AS lr, json_extract(value, '$[3]') AS hl, json_extract(value, '$[4]') AS st ` +
  `FROM json_each(?)) UPDATE memories SET retrieval_count = v.rc, last_retrieved = v.lr, half_life_days = v.hl, ` +
  `strength = v.st FROM v WHERE memories.id = v.id`;

/** strengthenRetrieved on the caller's handle, inside the caller's transaction. Throws; the
 * caller decides. */
export function strengthenRetrievedOn(
  db: DatabaseSyncLike,
  ids: readonly string[],
  opts: StrengthenOptions,
  rules: StoreModel,
): Set<string> {
  const found = new Set<string>();
  if (strengthensNothing(ids, opts)) return found;
  const byId = readEntriesByIds(db, ids, opts.tenantId);
  const live = [...new Set(ids)].flatMap((id) => byId.get(id) ?? []);
  const updated = markRetrieved(live, rules.clock(), rules.strength);
  if (updated.length === 0) return found;
  const rows = updated.map((e) => [
    e.id,
    e.retrievalCount,
    e.lastRetrieved,
    e.halfLifeDays,
    e.strength,
  ]);
  cachedStatement(db, RETRIEVAL_UPDATE_SQL).run(JSON.stringify(rows));
  for (const e of updated) found.add(e.id);
  return found;
}

/** Rewrites a live row's tags and its full-text row on the caller's transaction, with no audit
 * row. */
export function setEntryTagsInTx(db: DatabaseSyncLike, entry: MemoryEntry): void {
  cachedStatement(
    db,
    `UPDATE memories SET tags_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
  ).run(JSON.stringify(entry.tags), entry.id, entry.tenantId);
  syncFtsRow(db, entry);
}

/** Removes a row from `memories` and full-text search on the caller's transaction, as sleep's
 * dormant move does, and marks its summary parent dirty. */
export function deleteEntryRowInTx(db: DatabaseSyncLike, entry: MemoryEntry, actor: string): void {
  cachedStatement(db, 'DELETE FROM memories WHERE id = ? AND tenant_id = ?').run(
    entry.id,
    entry.tenantId,
  );
  deleteFtsRow(db, entry.id);
  if (entry.dagParentId) {
    markSummaryDirtyInTx(db, { summaryId: entry.dagParentId, tenantId: entry.tenantId, actor });
  }
}

// The last value given for an id wins, as a row-by-row write left it: UPDATE FROM applies any one
// of an id's matches.
export const lastPerId = (pairs: ReadonlyArray<readonly [string, number | string]>): string =>
  JSON.stringify([...new Map(pairs)]);

const HALF_LIFE_UPDATE_SQL =
  `WITH v AS (SELECT json_extract(value, '$[0]') AS id, json_extract(value, '$[1]') AS hl FROM json_each(?)) ` +
  `UPDATE memories SET half_life_days = v.hl FROM v WHERE memories.id = v.id`;

/** One half-life per memory id, in one statement on the caller's transaction. */
export function setHalfLives(
  db: DatabaseSyncLike,
  rows: readonly { id: string; halfLifeDays: number }[],
): void {
  if (rows.length === 0) return;
  cachedStatement(db, HALF_LIFE_UPDATE_SQL).run(lastPerId(rows.map((r) => [r.id, r.halfLifeDays])));
}
