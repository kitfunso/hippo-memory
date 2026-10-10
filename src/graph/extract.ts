/** Deterministic entity extraction: the graph is a pure function of the consolidated object tables (decisions, policies, customer_notes, project_briefs).
 *  Writes go through the src/store/graph-writes.ts consolidated-source guard. Pass 3 adds `references` edges by a conservative name-match heuristic. */

import { applyGraphOps } from './write.js';
import { runGraphRebuildTransaction } from '../store/graph-writes.js';
import { MAX_ENTITY_NAME_LEN, type EntityType, type SourceObjectType, type SourceObjectRef } from '../store/graph-rows.js';
import { graphDelta, readGraphDelta, type DesiredEntity, type DesiredGraph, type DesiredRelation, type NaturalKey } from './delta.js';
import { WRITE_BUDGET, type WriteBudget } from '../util/write-budget.js';
import { SLEEP_DB_WAIT_MS } from '../db/index.js';
import { loadDecisions } from '../objects/decisions.js';
import { loadPolicies } from '../objects/policies.js';
import { loadCustomerNotes } from '../objects/customer-notes.js';
import { loadProjectBriefs } from '../objects/project-briefs.js';
import { assertTenantId } from '../store/tenant.js';
import { escapeRegex } from '../util/escape.js';

/** Per-type load cap (the loaders default to 100); a type over it is truncated and `ExtractResult.truncated` records that. */
export const MAX_EXTRACT_PER_TYPE = 10000;

/** A target entity name must be in [MIN, MAX] chars to be matched: MIN skips short, generic words; MAX skips prose
 *  (a decision's prose name is never a target, only a source). */
export const MIN_REF_NAME_LEN = 4;
export const MAX_REF_NAME_LEN = 80;
/** Per-source cap so one object cannot explode the graph with references edges. */
export const MAX_REFERENCES_PER_OBJECT = 25;
/** Regex-size bound: at most this many distinct target names enter the combined
 *  alternation, keeping the scan regex sane on a huge store. */
export const MAX_TARGET_NAMES = 5000;

export interface ExtractResult {
  entities: number;
  relations: number;
  /** Of `relations`, how many are cross-object `references` edges (the rest are
   *  `supersedes`). Surfaced so the heuristic's output volume is observable. */
  references: number;
  /** Entity count per extracted type. */
  byType: Record<string, number>;
  /** Entity types whose active or superseded load hit MAX_EXTRACT_PER_TYPE (the graph
   *  is under-extracted for those). */
  truncated: string[];
  /** Writes left out because a writer changed their row or object after the diff; set only when above 0. */
  skipped?: number;
}

/** A consolidated object row normalised to the fields extraction needs. */
export interface ExtractRow {
  entityType: EntityType;
  /** The object table id (unique only WITHIN its table, hence keyed with entityType). */
  e2Id: number;
  name: string;
  /** The object's full text searched for OTHER entities' names in Pass 3. */
  searchText: string;
  memoryId: string | null;
  /** The successor's object id (Y) when this row (X) is superseded; null otherwise. */
  supersededBy: number | null;
}

/** Stable map key: entity types share an id space across tables, so key by both. */
function keyOf(entityType: EntityType, e2Id: number): string {
  return `${entityType}:${e2Id}`;
}

/** The four object-derived extraction entity types map 1:1 to source_object_type; the other
 *  two EntityType members ('person', 'system') have no object table and stay unmapped. */
const ENTITY_TYPE_TO_SOURCE_OBJECT = {
  decision: 'decision',
  policy: 'policy',
  customer: 'customer',
  project: 'project',
  person: undefined,
  system: undefined,
} satisfies Record<EntityType, SourceObjectType | undefined>;

/** The source-object ref for an extraction row (always set: every extracted row is a
 *  first-class object). Throws on an unmappable entityType (a graph invariant violation). */
function sourceObjectOf(entityType: EntityType, e2Id: number): SourceObjectRef {
  const type = ENTITY_TYPE_TO_SOURCE_OBJECT[entityType];
  if (!type) throw new Error(`graph-extract: entityType '${entityType}' has no source_object_type mapping`);
  return { type, id: e2Id };
}

/** Unordered entity-key pair, so a relation between a,b is found in either direction. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** The row fields extraction reads; every object loader's row type declares them. */
interface SourceRow {
  id: number;
  memoryId: string | null;
  supersededBy: number | null;
}

/** The slice of each loader's options extraction uses, assignable to every loader's own. */
interface SourceLoadOpts {
  status: 'active' | 'superseded';
  limit: number;
}

/** One object type's rows, loaded and normalised. */
export interface LoadedType {
  entityType: EntityType;
  rows: ExtractRow[];
  /** True when either status load filled MAX_EXTRACT_PER_TYPE. */
  hitCap: boolean;
}

/** Close over one loader's row type so the table below holds uniform functions. Loads ACTIVE and SUPERSEDED rows (not `closed`),
 *  one call per status, so MAX_EXTRACT_PER_TYPE is a per-status budget; `hitCap` is set when either load is full. */
function source<T extends SourceRow>(
  entityType: EntityType,
  load: (root: string, tenant: string, opts: SourceLoadOpts) => T[],
  nameOf: (row: T) => string,
  textOf: (row: T) => string,
): (hippoRoot: string, tenantId: string) => LoadedType {
  return (hippoRoot, tenantId) => {
    const rows: ExtractRow[] = [];
    let hitCap = false;
    for (const status of ['active', 'superseded'] as const) {
      const loaded = load(hippoRoot, tenantId, { status, limit: MAX_EXTRACT_PER_TYPE });
      if (loaded.length === MAX_EXTRACT_PER_TYPE) hitCap = true;
      for (const r of loaded) {
        rows.push({ entityType, e2Id: r.id, name: nameOf(r), searchText: textOf(r), memoryId: r.memoryId, supersededBy: r.supersededBy });
      }
    }
    return { entityType, rows, hitCap };
  };
}

const GRAPH_SOURCES: ReadonlyArray<(hippoRoot: string, tenantId: string) => LoadedType> = [
  source('decision', loadDecisions, (r) => r.decisionText, (r) => [r.decisionText, r.context].filter(Boolean).join(' ')),
  source('policy', loadPolicies, (r) => r.policyName, (r) => [r.policyName, r.policyText].filter(Boolean).join(' ')),
  source('customer', loadCustomerNotes, (r) => r.customer, (r) => [r.customer, r.note].filter(Boolean).join(' ')),
  source('project', loadProjectBriefs, (r) => r.repo, (r) => [r.repo, r.summary].filter(Boolean).join(' ')),
];

/** Every source type's rows, each read on its own connection; callers load before any write lock is taken. */
export function loadGraphSources(hippoRoot: string, tenantId: string): LoadedType[] {
  assertTenantId('loadGraphSources', tenantId);
  return GRAPH_SOURCES.map((load) => load(hippoRoot, tenantId));
}

/** The graph the loaded objects imply, plus the counts ExtractResult reports. */
export interface DerivedGraph extends DesiredGraph {
  byType: Record<string, number>;
  truncated: string[];
  references: number;
}

/** A derived entity with what Pass 3 needs; `key` stands in for the entity id the rebuild no longer has. */
interface DerivedEntity extends DesiredEntity {
  key: string;
  searchText: string;
  /** References are among active entities only; an edge to or from a superseded row is stale. */
  superseded: boolean;
}

interface DerivedEntities {
  byType: Record<string, number>;
  truncated: string[];
  allRows: ExtractRow[];
  byKey: Map<string, DerivedEntity>;
  /** In load order, which fixes insert order on a first build. */
  created: DerivedEntity[];
}

/** The tenant's graph as a pure function of its loaded objects; the write side diffs it against what is stored. */
export function deriveGraph(loaded: readonly LoadedType[]): DerivedGraph {
  const pass = deriveEntities(loaded);
  const supersedes = deriveSupersedes(pass);
  const references = deriveReferences(pass.created, supersedes.supersededPairs, pass.truncated);
  return {
    entities: pass.created.map((e) => ({ entityType: e.entityType, sourceObject: e.sourceObject, name: e.name, memoryId: e.memoryId })),
    relations: [...supersedes.relations, ...references],
    byType: pass.byType,
    truncated: pass.truncated,
    references: references.length,
  };
}

const naturalKeyOf = (e: DerivedEntity): NaturalKey => ({ entityType: e.entityType, sourceObject: e.sourceObject });

// Pass 1: every active or superseded object row becomes an entity anchored to its object, so it survives a
// forgotten mirror; the mirror memory rides along only while it exists.
function deriveEntities(loaded: readonly LoadedType[]): DerivedEntities {
  const pass: DerivedEntities = { byType: {}, truncated: [], allRows: [], byKey: new Map(), created: [] };
  for (const { entityType, rows, hitCap } of loaded) {
    if (hitCap) pass.truncated.push(entityType);
    pass.byType[entityType] = 0;
    for (const row of rows) {
      pass.allRows.push(row);
      // Names are uncapped at source; trimming on both sides of the cap gives the exact name insertEntity stores.
      const name = (row.name ?? '').trim().slice(0, MAX_ENTITY_NAME_LEN).trim();
      const key = keyOf(row.entityType, row.e2Id);
      // A row seen twice was superseded between the two status loads; its first sighting stands.
      if (name.length === 0 || pass.byKey.has(key)) continue;
      const entity: DerivedEntity = {
        entityType: row.entityType,
        sourceObject: sourceObjectOf(row.entityType, row.e2Id),
        name,
        memoryId: row.memoryId,
        key,
        searchText: row.searchText ?? '',
        superseded: row.supersededBy !== null,
      };
      pass.byKey.set(key, entity);
      pass.created.push(entity);
      pass.byType[entityType] += 1;
    }
  }
  return pass;
}

interface SupersedesPass {
  readonly relations: DesiredRelation[];
  readonly supersededPairs: Set<string>;
}

// Pass 2: "Y supersedes X" when both were derived (Y may be closed and absent). The edge is anchored to the
// successor's object and carries its mirror memory only while that lives.
function deriveSupersedes(pass: DerivedEntities): SupersedesPass {
  const relations: DesiredRelation[] = [];
  // Pass 3 skips these pairs: "Adopt X (managed)" containing "Adopt X" is a version, not a cross-reference.
  const supersededPairs = new Set<string>();
  for (const row of pass.allRows) {
    if (row.supersededBy === null) continue;
    const successor = pass.byKey.get(keyOf(row.entityType, row.supersededBy));
    const superseded = pass.byKey.get(keyOf(row.entityType, row.e2Id));
    if (!successor || !superseded) continue;
    relations.push({
      from: naturalKeyOf(successor),
      to: naturalKeyOf(superseded),
      relType: 'supersedes',
      memoryId: successor.memoryId,
      sourceObject: successor.sourceObject,
    });
    supersededPairs.add(pairKey(successor.key, superseded.key));
  }
  return { relations, supersededPairs };
}

/** Normalised name to its single target; a name two entities share is ambiguous and dropped. */
function referenceTargets(created: readonly DerivedEntity[]): Map<string, DerivedEntity> {
  const byName = new Map<string, DerivedEntity>();
  const ambiguous = new Set<string>();
  for (const e of created) {
    if (e.superseded) continue;
    // Decisions are sources only: their name is their prose, which would self-match and shadow embedded targets.
    if (e.entityType === 'decision') continue;
    const norm = e.name.trim().toLowerCase();
    if (norm.length < MIN_REF_NAME_LEN || norm.length > MAX_REF_NAME_LEN) continue;
    if (ambiguous.has(norm)) continue;
    const seen = byName.get(norm);
    if (seen === undefined) byName.set(norm, e);
    else if (seen.key !== e.key) {
      byName.delete(norm);
      ambiguous.add(norm);
    }
  }
  return byName;
}

// Pass 3: a `references` edge when one object's text names another entity, matched on word boundaries,
// self-skipped, deduped and capped per source; the edge is anchored to the source object.
function deriveReferences(created: readonly DerivedEntity[], supersededPairs: ReadonlySet<string>, truncated: string[]): DesiredRelation[] {
  const byName = referenceTargets(created);
  if (byName.size === 0) return [];
  if (byName.size > MAX_TARGET_NAMES) truncated.push('references-targets');
  // Longest first, then alphabetical: regex alternation is leftmost-first, so `postgres pro` beats `postgres`.
  const targetNames = [...byName.keys()]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_TARGET_NAMES);
  const re = new RegExp(`\\b(?:${targetNames.map(escapeRegex).join('|')})\\b`, 'gi');
  const relations: DesiredRelation[] = [];
  for (const src of created) {
    if (src.superseded || !src.searchText) continue;
    const targets = new Map<string, DerivedEntity>();
    for (const m of src.searchText.matchAll(re)) {
      const target = byName.get(m[0].toLowerCase());
      if (target === undefined || target.key === src.key) continue;
      if (supersededPairs.has(pairKey(src.key, target.key))) continue;
      targets.set(target.key, target);
      if (targets.size >= MAX_REFERENCES_PER_OBJECT) break;
    }
    for (const target of targets.values()) {
      relations.push({ from: naturalKeyOf(src), to: naturalKeyOf(target), relType: 'references', memoryId: src.memoryId, sourceObject: src.sourceObject });
    }
  }
  return relations;
}

function resultOf(derived: DerivedGraph, skipped: number): ExtractResult {
  const { entities, relations, references, byType, truncated } = derived;
  const result: ExtractResult = { entities: entities.length, relations: relations.length, references, byType, truncated };
  if (skipped > 0) result.skipped = skipped;
  return result;
}

/** Idempotent rebuild of the tenant's graph from its consolidated objects, in one transaction; safe to re-run.
 *  Returns the derived counts and which types hit the per-type cap. */
export function extractGraph(hippoRoot: string, tenantId: string): ExtractResult {
  assertTenantId('extractGraph', tenantId);
  // Loaded first: opening a second connection under the rebuild's BEGIN IMMEDIATE dead-locks ('database is locked').
  const derived = deriveGraph(loadGraphSources(hippoRoot, tenantId));
  // Diffed and applied under one lock, so two concurrent rebuilds serialize instead of both inserting a missing row.
  const skipped = runGraphRebuildTransaction(hippoRoot, tenantId, (txDb) =>
    applyGraphOps(txDb, hippoRoot, tenantId, graphDelta(txDb, tenantId, derived), { from: 0, holdMs: Infinity }).skipped,
  );
  return resultOf(derived, skipped);
}

/** extractGraph for sleep: diffs outside the lock, then applies in transactions of about `budget.holdMs` with a pause
 *  between them. A run stopped between chunks leaves a mixed graph that the next run's diff finishes. */
export async function extractGraphChunked(hippoRoot: string, tenantId: string, budget: WriteBudget = WRITE_BUDGET): Promise<ExtractResult> {
  assertTenantId('extractGraphChunked', tenantId);
  const derived = deriveGraph(loadGraphSources(hippoRoot, tenantId));
  const ops = readGraphDelta(hippoRoot, tenantId, derived);
  let next = 0;
  let skipped = 0;
  let committedAt = 0;
  while (next < ops.length) {
    if (next > 0) await budget.pause(committedAt);
    const from = next;
    // Sleep's wait, not a server request's 250 ms: each chunk is a fresh BEGIN IMMEDIATE a hook's write could otherwise fail.
    const chunk = runGraphRebuildTransaction(hippoRoot, tenantId, (txDb) =>
      applyGraphOps(txDb, hippoRoot, tenantId, ops, { from, holdMs: budget.holdMs, clock: budget.clock }),
    { busyWaitMs: SLEEP_DB_WAIT_MS });
    committedAt = budget.clock();
    next = chunk.next;
    skipped += chunk.skipped;
  }
  return resultOf(derived, skipped);
}


