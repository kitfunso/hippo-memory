// The rows one graph view shows: the newest of the whole graph, or the neighbourhood of one entity name.
import type { DatabaseSyncLike } from '../db/index.js';
import { IN_LIST_CHUNK, loadEntities, loadEntitiesByIds, loadEntitiesByName, loadNeighborRelations, loadRelations, loadRelationsAmong } from './graph-reads.js';
import type { GraphRows } from './port.js';

type CanRead = (scope: string | null) => boolean;

export interface GraphViewSpec {
  readonly entity?: string;
  readonly limit: number;
  readonly canRead?: CanRead;
}

/** The loaders take the root; `db` is the handle the caller's snapshot is open on, which every read here must use. */
interface GraphSource {
  readonly hippoRoot: string;
  readonly db: DatabaseSyncLike;
  readonly tenantId: string;
}

/** The items whose source memory `canRead` admits: a NULL memoryId has no scope to hide, and a missing memory fails closed. */
function readableOnly<T extends { memoryId: string | null }>(db: DatabaseSyncLike, tenantId: string, items: T[], canRead: CanRead | undefined): T[] {
  if (!canRead) return items;
  const ids = [...new Set(items.flatMap((i) => (i.memoryId === null ? [] : [i.memoryId])))];
  const readable = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_LIST_CHUNK) {
    const slice = ids.slice(i, i + IN_LIST_CHUNK);
    // SAFETY: rows' shape matches the id and scope columns named in the SELECT.
    const rows = db.prepare(`SELECT id, scope FROM memories WHERE +tenant_id = ? AND id IN (${slice.map(() => '?').join(',')})`)
      .all(tenantId, ...slice) as Array<{ id: string; scope: string | null }>;
    for (const r of rows) if (canRead(r.scope)) readable.add(r.id);
  }
  return items.filter((i) => i.memoryId === null || readable.has(i.memoryId));
}

function wholeGraphRows({ hippoRoot, db, tenantId }: GraphSource, limit: number): GraphRows {
  const entities = loadEntities(hippoRoot, tenantId, { limit }, db);
  const relations = loadRelations(hippoRoot, tenantId, { limit }, db);
  return { entities, relations, truncated: entities.length >= limit || relations.length >= limit };
}

/** The named entities with their 1-hop neighbours and the edges among that union; null when the caller may read none of the named ones. */
function focusRows({ hippoRoot, db, tenantId }: GraphSource, name: string, limit: number, canRead: CanRead | undefined): GraphRows | null {
  // The name is queried directly, so it is found on a graph larger than `limit`; one name can map to many entities, so the matches are capped.
  const named = loadEntitiesByName(hippoRoot, tenantId, name, { limit }, db);
  // A hidden focus must not answer through its neighbours that the name exists.
  const focus = readableOnly(db, tenantId, named, canRead);
  if (focus.length === 0) return null;
  const focusIds = focus.map((e) => e.id);
  const hop = loadNeighborRelations(hippoRoot, tenantId, focusIds, { limit }, db);
  const union = new Set<number>(focusIds);
  let neighboursCapped = false;
  for (const r of hop) {
    if (union.size >= limit) {
      neighboursCapped = true; // node cap filled before all neighbours were added
      break;
    }
    union.add(r.fromEntityId);
    union.add(r.toEntityId);
  }
  const unionIds = [...union].slice(0, limit);
  const entities = loadEntitiesByIds(hippoRoot, tenantId, unionIds, db);
  // Both endpoints in the set: neighbour-to-neighbour edges are included, and the LIMIT never drops one for an out-of-union row.
  const relations = loadRelationsAmong(hippoRoot, tenantId, unionIds, { limit }, db);
  const truncated =
    named.length >= limit ||
    hop.length >= limit || // neighbour scan capped -> a 1-hop neighbour may be omitted
    neighboursCapped || // node cap filled before all neighbours were consumed
    union.size > unionIds.length ||
    relations.length >= limit;
  return { entities, relations, truncated };
}

/** What `GraphReads.graphRows` answers, read on `db`: the caller opens the one
 * snapshot that keeps entity ids and relation ids from two different rebuilds apart. */
export function graphViewRows(hippoRoot: string, db: DatabaseSyncLike, tenantId: string, spec: GraphViewSpec): GraphRows {
  const source = { hippoRoot, db, tenantId };
  const raw = spec.entity !== undefined ? focusRows(source, spec.entity, spec.limit, spec.canRead) : wholeGraphRows(source, spec.limit);
  if (raw === null) return { entities: [], relations: [], truncated: false };
  return {
    entities: readableOnly(db, tenantId, raw.entities, spec.canRead),
    relations: readableOnly(db, tenantId, raw.relations, spec.canRead),
    truncated: raw.truncated,
  };
}
