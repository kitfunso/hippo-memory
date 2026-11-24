import { withReadSnapshot, type DatabaseSyncLike } from '../../../db/index.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type { DesiredGraph, GraphOp } from '../../../base/ports/store/graph.js';
import { entityKey, wantedEntities, wantedRelations } from '../../rules/graph-delta.js';

const PROVENANCE = `CASE WHEN m.id IS NULL THEN '|distilled' ELSE m.id || '|' || IFNULL(m.kind, 'null') END`;
const STORED_KEY = `entity_type || '|' || source_object_type || ':' || source_object_id`;

const KEPT = `kept AS MATERIALIZED (
  SELECT min(id) AS id, k FROM (SELECT id, ${STORED_KEY} AS k FROM entities WHERE tenant_id = ?)
  WHERE k IN (SELECT k FROM want_e) GROUP BY k)`;

const ENTITY_DELTA = `WITH want_e AS MATERIALIZED (
  SELECT w.key AS idx, json_extract(w.value, '$[0]') AS k, json_extract(w.value, '$[1]') AS name, ${PROVENANCE} AS prov
  FROM json_each(?) w LEFT JOIN memories m ON m.id = json_extract(w.value, '$[2]')),
${KEPT}
SELECT 0 AS step, id AS at, id FROM entities WHERE tenant_id = ? AND id NOT IN (SELECT id FROM kept)
UNION ALL
SELECT 1, w.idx, e.id FROM want_e w JOIN kept ON kept.k = w.k JOIN entities e ON e.id = kept.id
  WHERE e.name IS NOT w.name OR COALESCE(e.memory_id, '') || '|' || e.source_kind IS NOT w.prov
UNION ALL
SELECT 2, idx, NULL FROM want_e WHERE k NOT IN (SELECT k FROM kept)
ORDER BY step, at`;

const RELATION_DELTA = `WITH want_e AS MATERIALIZED (SELECT json_extract(value, '$[0]') AS k FROM json_each(?)),
${KEPT},
want_r AS MATERIALIZED (
  SELECT w.key AS idx, json_extract(w.value, '$[0]') AS k, ${PROVENANCE} AS prov,
    json_extract(w.value, '$[2]') AS ot, json_extract(w.value, '$[3]') AS oi
  FROM json_each(?) w LEFT JOIN memories m ON m.id = json_extract(w.value, '$[1]')),
rel AS MATERIALIZED (
  SELECT r.id, f.k || '>' || t.k || '|' || r.rel_type AS k,
    COALESCE(r.memory_id, '') || '|' || r.source_kind AS prov, r.source_object_type AS ot, r.source_object_id AS oi
  FROM relations r JOIN kept f ON f.id = r.from_entity_id JOIN kept t ON t.id = r.to_entity_id
  WHERE r.tenant_id = ?),
same AS MATERIALIZED (
  SELECT min(rel.id) AS id, rel.k FROM rel
  JOIN want_r w ON w.k = rel.k AND w.prov IS rel.prov AND w.ot IS rel.ot AND w.oi IS rel.oi
  GROUP BY rel.k)
SELECT 0 AS step, id AS at FROM rel WHERE id NOT IN (SELECT id FROM same)
UNION ALL
SELECT 1, idx FROM want_r WHERE k NOT IN (SELECT k FROM same)
ORDER BY step, at`;

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
type EntityDeltaRow = { step: 0 | 1 | 2; at: number; id: number | null };

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
type RelationDeltaRow = { step: 0 | 1; at: number };

/** The ops diffGraph plans, in its apply order, from two statements on one snapshot. */
export function graphDeltaOn(
  db: DatabaseSyncLike,
  tenantId: string,
  desired: DesiredGraph,
): GraphOp[] {
  const entities = [...wantedEntities(desired).values()];
  const relations = [...wantedRelations(desired)];
  const entityJson = JSON.stringify(entities.map((e) => [entityKey(e), e.name, e.memoryId]));
  const relationJson = JSON.stringify(
    relations.map(([key, r]) => [key, r.memoryId, r.sourceObject.type, r.sourceObject.id]),
  );
  return withReadSnapshot(db, () => {
    const entityRows = cachedStatement(db, ENTITY_DELTA).all(
      entityJson,
      tenantId,
      tenantId,
    ) as EntityDeltaRow[];
    const relationRows = cachedStatement(db, RELATION_DELTA).all(
      entityJson,
      tenantId,
      relationJson,
      tenantId,
    ) as RelationDeltaRow[];
    return [
      ...entityRows.map((row): GraphOp => {
        if (row.step === 0) return { op: 'deleteEntity', id: row.at };
        const entity = entities[row.at]!;
        return row.step === 1
          ? { op: 'updateEntity', id: row.id!, entity }
          : { op: 'insertEntity', entity };
      }),
      ...relationRows.map((row): GraphOp =>
        row.step === 0
          ? { op: 'deleteRelation', id: row.at }
          : { op: 'insertRelation', relation: relations[row.at]![1] },
      ),
    ];
  });
}
