import type { ScopeActor } from '../../core/recall-scope.js';
import type { Entity, Relation, StoredGraph } from '../graph-rows.js';

/** What one graph view reads. `limit` is a positive integer capping each read on its own; newest means createdAt, then
 * id, both descending. A row shows when it cites no memory, or its memory is in the tenant with a null scope or one
 * `canReadScope(reader, scope)` admits; no `reader` shows every row. */
export interface GraphViewQuery {
  /** Unset reads the whole graph. Set, the start entities are the first `limit` of exactly this name (lowest id first)
   * that show; none left answers empty. Per 400 start ids, the newest `limit` relations with an end among them join in,
   * each adding its other end to the ids held, until `limit` ids are held. */
  readonly entity?: string;
  readonly limit: number;
  readonly reader?: ScopeActor;
}

export interface GraphRows {
  readonly entities: Entity[];
  /** May name an entity `entities` lacks; the caller drops such a relation. */
  readonly relations: Relation[];
  /** Judged before a row is hidden: true when start entities, joined relations, returned relations or (whole graph)
   * returned entities came back `limit` long, or the walk held `limit` ids with a relation still to join. */
  readonly truncated: boolean;
}

/** The rows behind GET /v1/graph. */
export interface GraphReads {
  /** Every read from one snapshot, then rows that do not show are dropped. Whole graph: the tenant's newest `limit`
   * entities and relations. From a name: the entities of the ids held (id ascending, 400 at a time) and the newest
   * `limit` relations with both ends among those ids. */
  graphRows(tenantId: string, query: GraphViewQuery): Promise<GraphRows>;
  entitiesForMemories(tenantId: string, memoryIds: readonly string[]): Promise<Entity[]>;
  entitiesByIds(tenantId: string, ids: readonly number[]): Promise<Entity[]>;
  neighborRelations(
    tenantId: string, entityIds: readonly number[], opts: { readonly limit: number },
  ): Promise<Relation[]>;
  /** The tenant's entities and relations, each id ascending, and the kind of each of `memoryIds` held in any tenant. */
  storedGraph(tenantId: string, memoryIds: readonly string[]): Promise<StoredGraph>;
}
