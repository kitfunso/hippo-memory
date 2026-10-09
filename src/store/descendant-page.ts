// A summary's descendants read as a page: every level is counted, and only the rows the caller shows are read whole.
import type { DatabaseSyncLike } from '../db/index.js';
import type { MemoryEntry } from '../core/memory.js';
import { chunked, selectEntriesByIds, TENANT_IS } from './entry-reads.js';
import type { DescendantOrigin, DescendantPage, SummaryDescendants } from './port.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from './rows.js';

export interface PagedWalk {
  readonly tenantId: string;
  readonly summary: MemoryEntry;
  readonly depth: number;
  readonly page: DescendantPage;
}

interface LevelRead {
  /** Ids of every admitted row, in level order; empty for the last level, which has nothing under it to read. */
  readonly ids: readonly string[];
  readonly size: number;
  readonly rows: MemoryEntry[];
}

interface ChildKey extends DescendantOrigin {
  readonly id: string;
  readonly dag_parent_id: string;
}

interface ChildGroup extends DescendantOrigin {
  readonly dag_parent_id: string;
  readonly n: number;
}

const marks = (ids: readonly string[]): string => ids.map(() => '?').join(',');

/** The walk `summaryWithDescendants` documents, with `levels` cut to the first `page.rows` rows and each level's full count in `sizes`. */
export function pagedDescendants(db: DatabaseSyncLike, walk: PagedWalk, summaryAdmitted: boolean): SummaryDescendants {
  const sizes: number[] = [];
  const levels: MemoryEntry[][] = [];
  const seen = new Set<string>([walk.summary.id]);
  let room = Math.max(0, walk.page.rows);
  let parents: readonly string[] = summaryAdmitted ? [walk.summary.id] : [];
  for (let level = 0; level < walk.depth && parents.length > 0; level++) {
    const counted = level === walk.depth - 1 ? countedLevel(db, walk, parents, room) : null;
    const read = counted ?? keyedLevel(db, walk, parents, { seen, room });
    if (read.size === 0) break;
    sizes.push(read.size);
    levels.push(read.rows);
    room -= read.rows.length;
    parents = read.ids;
  }
  return { summary: walk.summary, levels, sizes };
}

// Reads four short columns of every child, since the level below needs each admitted id as a parent.
function keyedLevel(db: DatabaseSyncLike, walk: PagedWalk, parents: readonly string[], at: { seen: Set<string>; room: number }): LevelRead {
  const byParent = new Map<string, ChildKey[]>();
  for (const chunk of chunked([...parents])) {
    // SAFETY: the SELECT names exactly ChildKey's four columns, and the WHERE keeps dag_parent_id a string.
    const keys = db.prepare(
      `SELECT id, dag_parent_id, scope, origin_project FROM memories WHERE dag_parent_id IN (${marks(chunk)}) AND ${TENANT_IS} ORDER BY created ASC, id ASC`,
    ).all(...chunk, walk.tenantId) as ChildKey[];
    for (const key of keys) {
      const bucket = byParent.get(key.dag_parent_id);
      if (bucket) bucket.push(key);
      else byParent.set(key.dag_parent_id, [key]);
    }
  }
  const ids: string[] = [];
  for (const parentId of parents) {
    for (const key of byParent.get(parentId) ?? []) {
      if (at.seen.has(key.id) || !walk.page.admit(key)) continue;
      at.seen.add(key.id);
      ids.push(key.id);
    }
  }
  const shown = ids.slice(0, Math.max(0, at.room));
  const whole = selectEntriesByIds(db, shown, walk.tenantId);
  return { ids, size: ids.length, rows: shown.flatMap((id) => whole.get(id) ?? []) };
}

/** The last level counted in SQL and read up to `room` rows; null when a row there is refused, which only the keyed read can leave out.
 *  A row has one parent and a parent is read at one level, so the summary is the only row an earlier level can already hold. */
function countedLevel(db: DatabaseSyncLike, walk: PagedWalk, parents: readonly string[], room: number): LevelRead | null {
  const perParent = new Map<string, number>();
  for (const chunk of chunked([...parents])) {
    // SAFETY: the SELECT names exactly ChildGroup's four fields, and the WHERE keeps dag_parent_id a string.
    const groups = db.prepare(
      `SELECT dag_parent_id, scope, origin_project, COUNT(*) AS n FROM memories WHERE dag_parent_id IN (${marks(chunk)}) AND ${TENANT_IS} AND id <> ? GROUP BY dag_parent_id, scope, origin_project`,
    ).all(...chunk, walk.tenantId, walk.summary.id) as ChildGroup[];
    for (const group of groups) {
      if (!walk.page.admit(group)) return null;
      perParent.set(group.dag_parent_id, (perParent.get(group.dag_parent_id) ?? 0) + Number(group.n));
    }
  }
  let size = 0;
  for (const n of perParent.values()) size += n;
  return { ids: [], size, rows: firstRows(db, walk, parents.filter((id) => perParent.has(id)), { perParent, room }) };
}

// Every parent before the one the page ends in is read whole in one statement; that last one is read under a LIMIT.
function firstRows(db: DatabaseSyncLike, walk: PagedWalk, parents: readonly string[], at: { perParent: ReadonlyMap<string, number>; room: number }): MemoryEntry[] {
  const whole: string[] = [];
  let left = at.room;
  for (const parentId of parents) {
    if (left <= 0) break;
    const n = at.perParent.get(parentId) ?? 0;
    if (n >= left) return [...childrenInOrder(db, walk, whole, -1), ...childrenInOrder(db, walk, [parentId], left)];
    whole.push(parentId);
    left -= n;
  }
  return childrenInOrder(db, walk, whole, -1);
}

/** Children parent by parent, each parent's by created then id; a negative `limit` reads them all. */
function childrenInOrder(db: DatabaseSyncLike, walk: PagedWalk, parents: readonly string[], limit: number): MemoryEntry[] {
  const byParent = new Map<string, MemoryEntry[]>();
  for (const chunk of chunked([...parents])) {
    // SAFETY: selects exactly MEMORY_SELECT_COLUMNS, matching MemoryRow's field set.
    const rows = db.prepare(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE dag_parent_id IN (${marks(chunk)}) AND ${TENANT_IS} AND id <> ? ORDER BY created ASC, id ASC LIMIT ?`,
    ).all(...chunk, walk.tenantId, walk.summary.id, limit) as MemoryRow[];
    for (const row of rows) {
      const bucket = byParent.get(row.dag_parent_id ?? '');
      if (bucket) bucket.push(rowToEntry(row));
      else byParent.set(row.dag_parent_id ?? '', [rowToEntry(row)]);
    }
  }
  return parents.flatMap((id) => byParent.get(id) ?? []);
}
