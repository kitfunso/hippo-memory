// The rows one graph view shows: the newest of the whole graph, or the neighborhood of one entity name.
import type { DatabaseSyncLike } from '../db/index.js';
import {
  IN_LIST_CHUNK,
  loadEntitiesAt,
  loadEntitiesByIdsAt,
  loadEntitiesByNameAt,
  loadNeighborRelationsAt,
  loadRelationsAt,
  loadRelationsAmongAt,
} from './graph-reads.js';
import type { GraphRows } from './port.js';
import { placeholders } from '../util/sql.js';

type CanRead = (scope: string | null) => boolean;

export interface GraphViewSpec {
  readonly entity?: string;
  readonly limit: number;
  readonly canRead?: CanRead;
}

/** `db` is the handle the caller's snapshot is open on, which every read here must use. */
interface GraphSource {
  readonly db: DatabaseSyncLike;
  readonly tenantId: string;
}

/** The items whose source memory `canRead` admits: a NULL memoryId has no scope to hide, and a missing memory fails
 * closed. */
function readableOnly<T extends { memoryId: string | null }>(
  db: DatabaseSyncLike,
  tenantId: string,
  items: T[],
  canRead: CanRead | undefined,
): T[] {
  if (!canRead) return items;
  const ids = [...new Set(items.flatMap((i) => (i.memoryId === null ? [] : [i.memoryId])))];
  const readable = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
    const slice = ids.slice(i, i + IN_LIST_CHUNK);
    // SAFETY: rows' shape matches the id and scope columns named in the SELECT.
    const rows = db
      .prepare(`SELECT id, scope FROM memories WHERE +tenant_id = ? AND id IN (${placeholders(slice.length)})`)
      .all(tenantId, ...slice) as Array<{ id: string; scope: string | null }>;
    for (const r of rows) if (canRead(r.scope)) readable.add(r.id);
  }
  return items.filter((i) => i.memoryId === null || readable.has(i.memoryId));
}

function wholeGraphRows({ db, tenantId }: GraphSource, limit: number): GraphRows {
  const entities = loadEntitiesAt(db, tenantId, { limit });
  const relations = loadRelationsAt(db, tenantId, { limit });
  return { entities, relations, truncated: entities.length >= limit || relations.length >= limit };
}

/** The named entities with their 1-hop neighbors and the edges among that union; null when the caller may read none of
 * the named ones. */
function focusRows(
  { db, tenantId }: GraphSource,
  name: string,
  limit: number,
  canRead: CanRead | undefined,
): GraphRows | null {
  // The name is queried directly, so it is found on a graph larger than `limit`; one name can map to many entities, so
  // the matches are capped.
  const named = loadEntitiesByNameAt(db, tenantId, name, { limit });
  // A hidden focus must not answer through its neighbors that the name exists.
  const focus = readableOnly(db, tenantId, named, canRead);
  if (focus.length === 0) return null;
  const focusIds = focus.map((e) => e.id);
  const hop = loadNeighborRelationsAt(db, tenantId, focusIds, { limit });
  const union = new Set<number>(focusIds);
  let neighborsCapped = false;
  for (const r of hop) {
    if (union.size >= limit) {
      neighborsCapped = true; // node cap filled before all neighbors were added
      break;
    }
    union.add(r.fromEntityId);
    union.add(r.toEntityId);
  }
  const unionIds = [...union].slice(0, limit);
  const entities = loadEntitiesByIdsAt(db, tenantId, unionIds);
  // Both endpoints in the set: neighbor-to-neighbor edges are included, and the LIMIT never drops one for an
  // out-of-union row.
  const relations = loadRelationsAmongAt(db, tenantId, unionIds, { limit });
  const truncated =
    named.length >= limit ||
    hop.length >= limit || // neighbor scan capped -> a 1-hop neighbor may be omitted
    neighborsCapped || // node cap filled before all neighbors were consumed
    union.size > unionIds.length ||
    relations.length >= limit;
  return { entities, relations, truncated };
}

/** What `GraphReads.graphRows` answers, read on `db`: the caller opens the one
 * snapshot that keeps entity ids and relation ids from two different rebuilds apart. */
export function graphViewRows(db: DatabaseSyncLike, tenantId: string, spec: GraphViewSpec): GraphRows {
  const source = { db, tenantId };
  const raw =
    spec.entity !== undefined
      ? focusRows(source, spec.entity, spec.limit, spec.canRead)
      : wholeGraphRows(source, spec.limit);
  if (raw === null) return { entities: [], relations: [], truncated: false };
  return {
    entities: readableOnly(db, tenantId, raw.entities, spec.canRead),
    relations: readableOnly(db, tenantId, raw.relations, spec.canRead),
    truncated: raw.truncated,
  };
}
