/**
 * E3.1 deterministic entity extraction (first slice)
 * (docs/plans/2026-06-01-e3-deterministic-extraction.md).
 *
 * Populates the E3 graph from the already-structured consolidated E2-object tables -
 * NO NLP, no precision gate. The graph is a pure derived function of the current E2
 * state, so `extractGraph` is an idempotent REBUILD: clear the tenant's graph, then
 * re-derive entities + `supersedes` relations from decisions / policies /
 * customer_notes / project_briefs (the four E2 types whose kind maps to the
 * `entity_type` enum). All writes go through the src/graph.ts consolidated-source
 * guard (insertEntity / insertRelation / clearGraph); this module issues no raw SQL.
 *
 * Deferred (follow-ups): NLP prose-extraction from raw/distilled memories (the
 * 80%-precision gold-set part); skill/incident/process entities (not in the
 * entity_type enum); cross-object relations beyond supersedes; the `hippo sleep`
 * enqueue-hook; E3.2 multi-hop recall. When a SECOND producer (NLP) lands, extraction
 * will need a `source` marker so the rebuild scopes to only the deterministically-
 * extracted rows.
 */

import { clearGraph, insertEntity, insertRelation, MAX_ENTITY_NAME_LEN, type EntityType } from './graph.js';
import { loadDecisions } from './decisions.js';
import { loadPolicies } from './policies.js';
import { loadCustomerNotes } from './customer-notes.js';
import { loadProjectBriefs } from './project-briefs.js';
import { assertTenantId } from './store.js';

/** Per-type load cap (the loaders default to 100). A type whose active or superseded
 *  set exceeds this is truncated; `ExtractResult.truncated` records it so the
 *  incompleteness is observable rather than silent. */
export const MAX_EXTRACT_PER_TYPE = 10000;

export interface ExtractResult {
  entities: number;
  relations: number;
  /** Entity count per extracted type. */
  byType: Record<string, number>;
  /** Entity types whose active or superseded load hit MAX_EXTRACT_PER_TYPE (the graph
   *  is under-extracted for those). */
  truncated: string[];
}

/** A consolidated E2 row normalised to the fields extraction needs. */
interface ExtractRow {
  entityType: EntityType;
  /** The E2 table id (unique only WITHIN its table, hence keyed with entityType). */
  e2Id: number;
  name: string;
  memoryId: string | null;
  /** The successor's E2 id (Y) when this row (X) is superseded; null otherwise. */
  supersededBy: number | null;
}

/** Stable map key: entity types share an id space across tables, so key by both. */
function keyOf(entityType: EntityType, e2Id: number): string {
  return `${entityType}:${e2Id}`;
}

/**
 * Load a type's ACTIVE + SUPERSEDED rows (excluding `closed` = retired), normalised.
 * Calls the loader once per status so MAX_EXTRACT_PER_TYPE is a per-status budget
 * (closed rows never consume it). Sets `hitCap` when either status load is full.
 */
function loadType(
  hippoRoot: string,
  tenantId: string,
  entityType: EntityType,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loadFn: (root: string, tenant: string, opts: any) => any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nameOf: (row: any) => string,
): { rows: ExtractRow[]; hitCap: boolean } {
  const rows: ExtractRow[] = [];
  let hitCap = false;
  for (const status of ['active', 'superseded'] as const) {
    const loaded = loadFn(hippoRoot, tenantId, { status, limit: MAX_EXTRACT_PER_TYPE });
    if (loaded.length === MAX_EXTRACT_PER_TYPE) hitCap = true;
    for (const r of loaded) {
      rows.push({
        entityType,
        e2Id: r.id as number,
        name: nameOf(r),
        memoryId: (r.memoryId ?? null) as string | null,
        supersededBy: (r.supersededBy ?? null) as number | null,
      });
    }
  }
  return { rows, hitCap };
}

/**
 * Idempotent rebuild of the tenant's deterministic graph from its consolidated E2
 * objects. Returns the entity/relation counts (+ which types were truncated at the
 * per-type cap). Safe to re-run: output is a pure function of the current E2 state.
 */
export function extractGraph(hippoRoot: string, tenantId: string): ExtractResult {
  assertTenantId('extractGraph', tenantId);

  const sources: Array<{
    entityType: EntityType;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadFn: (root: string, tenant: string, opts: any) => any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nameOf: (row: any) => string;
  }> = [
    { entityType: 'decision', loadFn: loadDecisions, nameOf: (r) => r.decisionText },
    { entityType: 'policy', loadFn: loadPolicies, nameOf: (r) => r.policyName },
    { entityType: 'customer', loadFn: loadCustomerNotes, nameOf: (r) => r.customer },
    { entityType: 'project', loadFn: loadProjectBriefs, nameOf: (r) => r.repo },
  ];

  // Rebuild from scratch: the graph is derived, so clear then re-derive.
  clearGraph(hippoRoot, tenantId);

  const byType: Record<string, number> = {};
  const truncated: string[] = [];
  const allRows: ExtractRow[] = [];
  const entityIdByKey = new Map<string, number>();
  const memoryIdByKey = new Map<string, string>();

  // Pass 1: entities. Skip rows whose source memory was forgotten (NULL memory_id) -
  // an entity must reference a consolidated memory (entities.memory_id is NOT NULL).
  for (const src of sources) {
    const { rows, hitCap } = loadType(hippoRoot, tenantId, src.entityType, src.loadFn, src.nameOf);
    if (hitCap) truncated.push(src.entityType);
    byType[src.entityType] = 0;
    for (const row of rows) {
      allRows.push(row);
      if (row.memoryId === null) continue;
      // Normalise the label so a long/odd-but-valid E2 name can never throw in
      // insertEntity and (because clearGraph already ran) brick the rebuild
      // unrebuildably. E2 name fields (decisionText / policyName) are UNCAPPED at
      // source, and insertEntity REJECTS (not truncates) both an over-cap name AND an
      // empty one. So: TRIM FIRST (codex 2026-06-01: >512 leading-whitespace chars
      // would otherwise slice to a whitespace-only string -> trimmed to '' ->
      // 'name is required' throw), THEN cap to MAX_ENTITY_NAME_LEN; if the normalised
      // label is empty (the E2 save APIs forbid this, but be defensive) skip the row
      // rather than throw. This closes the entire name-brick class.
      const name = (row.name ?? '').trim().slice(0, MAX_ENTITY_NAME_LEN);
      if (name.length === 0) continue;
      const entity = insertEntity(hippoRoot, tenantId, {
        entityType: row.entityType,
        name,
        memoryId: row.memoryId,
      });
      const k = keyOf(row.entityType, row.e2Id);
      entityIdByKey.set(k, entity.id);
      memoryIdByKey.set(k, row.memoryId);
      byType[src.entityType] += 1;
    }
  }

  // Pass 2: `supersedes` relations. For X superseded by Y (Y is the successor), emit
  // "Y supersedes X" - but only when BOTH X and Y were extracted (e.g. Y may be closed
  // and absent). The relation is sourced from Y's consolidated memory.
  let relations = 0;
  for (const row of allRows) {
    if (row.supersededBy === null) continue;
    const xKey = keyOf(row.entityType, row.e2Id);
    const yKey = keyOf(row.entityType, row.supersededBy);
    const fromId = entityIdByKey.get(yKey); // successor Y
    const toId = entityIdByKey.get(xKey); // superseded X
    const yMemoryId = memoryIdByKey.get(yKey);
    if (fromId === undefined || toId === undefined || yMemoryId === undefined) continue;
    insertRelation(hippoRoot, tenantId, {
      fromEntityId: fromId,
      toEntityId: toId,
      relType: 'supersedes',
      memoryId: yMemoryId,
    });
    relations += 1;
  }

  const entities = Array.from(entityIdByKey.keys()).length;
  return { entities, relations, byType, truncated };
}
