import * as path from 'path';
import type { MemoryEntry } from '../memory.js';
import { openHippoDb, isFtsAvailable } from '../db.js';
import { deriveOriginProject, originFromSource } from '../project-identity.js';
import { checkRejectionGuard } from '../rejection.js';
import { log } from '../log.js';

/**
 * `bypassRejectionGuard`: ONLY `batchWriteAndDelete` passes `true`; its merges concatenate
 * already-guarded facts, and it re-probes tombstones in-transaction before each upsert.
 */
export function upsertEntryRow(
  db: ReturnType<typeof openHippoDb>,
  entry: MemoryEntry,
  bypassRejectionGuard = false,
): void {
  if (!bypassRejectionGuard) {
    checkRejectionGuard(db, entry.tenantId ?? 'default', entry.id, entry.content);
  }
  const isNewRow = db.prepare(`SELECT 1 FROM memories WHERE id = ?`).get(entry.id) === undefined;
  db.prepare(UPSERT_MEMORY_SQL).run(...memoryRowValues(entry));

  syncFtsRow(db, entry, isNewRow);
}

const UPSERT_MEMORY_SQL = `
    INSERT INTO memories(
      id, created, last_retrieved, retrieval_count, strength, half_life_days, layer,
      tags_json, emotional_valence, schema_fit, source, outcome_score,
      outcome_positive, outcome_negative,
      conflicts_with_json, pinned, confidence, content,
      parents_json, starred,
      trace_outcome, source_session_id,
      valid_from, superseded_by,
      extracted_from,
      dag_level, dag_parent_id,
      kind, scope, owner, artifact_ref,
      tenant_id, origin_project,
      descendant_count, earliest_at, latest_at,
      dag_level_3_built_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      created = excluded.created,
      last_retrieved = excluded.last_retrieved,
      retrieval_count = excluded.retrieval_count,
      strength = excluded.strength,
      half_life_days = excluded.half_life_days,
      layer = excluded.layer,
      tags_json = excluded.tags_json,
      emotional_valence = excluded.emotional_valence,
      schema_fit = excluded.schema_fit,
      source = excluded.source,
      outcome_score = excluded.outcome_score,
      outcome_positive = excluded.outcome_positive,
      outcome_negative = excluded.outcome_negative,
      conflicts_with_json = excluded.conflicts_with_json,
      pinned = excluded.pinned,
      confidence = excluded.confidence,
      content = excluded.content,
      parents_json = excluded.parents_json,
      starred = excluded.starred,
      trace_outcome = excluded.trace_outcome,
      source_session_id = excluded.source_session_id,
      valid_from = excluded.valid_from,
      superseded_by = excluded.superseded_by,
      extracted_from = excluded.extracted_from,
      dag_level = excluded.dag_level,
      dag_parent_id = excluded.dag_parent_id,
      kind = excluded.kind,
      scope = excluded.scope,
      owner = excluded.owner,
      artifact_ref = excluded.artifact_ref,
      tenant_id = excluded.tenant_id,
      origin_project = excluded.origin_project,
      descendant_count = excluded.descendant_count,
      earliest_at = excluded.earliest_at,
      latest_at = excluded.latest_at,
      dag_level_3_built_at = excluded.dag_level_3_built_at,
      updated_at = datetime('now')
  `;

/** Bind values for UPSERT_MEMORY_SQL, in its column order. */
function memoryRowValues(entry: MemoryEntry): Array<string | number | null> {
  return [
    entry.id,
    entry.created,
    entry.last_retrieved,
    entry.retrieval_count,
    entry.strength,
    entry.half_life_days,
    entry.layer,
    JSON.stringify(entry.tags ?? []),
    entry.emotional_valence,
    entry.schema_fit,
    entry.source,
    entry.outcome_score,
    entry.outcome_positive ?? 0,
    entry.outcome_negative ?? 0,
    JSON.stringify(entry.conflicts_with ?? []),
    entry.pinned ? 1 : 0,
    entry.confidence,
    entry.content,
    JSON.stringify(entry.parents ?? []),
    entry.starred ? 1 : 0,
    entry.trace_outcome ?? null,
    entry.source_session_id ?? null,
    entry.valid_from ?? entry.created,
    entry.superseded_by ?? null,
    entry.extracted_from ?? null,
    entry.dag_level ?? 0,
    entry.dag_parent_id ?? null,
    entry.kind ?? 'distilled',
    entry.scope ?? null,
    entry.owner ?? null,
    entry.artifact_ref ?? null,
    entry.tenantId ?? 'default',
    entry.origin_project ?? null,
    entry.descendant_count ?? 0,
    entry.earliest_at ?? null,
    entry.latest_at ?? null,
    entry.dag_level_3_built_at ?? null,
  ];
}

export function syncFtsRow(db: ReturnType<typeof openHippoDb>, entry: MemoryEntry, isNewRow = false): void {
  if (!isFtsAvailable(db)) return;
  try {
    if (!isNewRow) db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(entry.id);
    db.prepare(`INSERT INTO memories_fts(id, content, tags) VALUES (?, ?, ?)`).run(
      entry.id,
      entry.content,
      entry.tags.join(' ')
    );
  } catch (err) {
    // The memories table stays authoritative; a stale FTS row only costs recall quality, so the write goes on.
    log.warnThenDebug('fts-sync', `FTS index update failed for ${entry.id}; keyword recall may miss it: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function deleteFtsRow(db: ReturnType<typeof openHippoDb>, id: string): void {
  if (!isFtsAvailable(db)) return;
  try {
    db.prepare(`DELETE FROM memories_fts WHERE id = ?`).run(id);
  } catch (err) {
    log.warnThenDebug('fts-delete', `FTS index delete failed for ${id}; recall may return a stale hit: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Write a memory entry to SQLite and refresh compatibility mirrors.
 *
 * `opts.actor` defaults to 'cli' so unauthenticated direct-CLI callers still
 * get the right audit attribution. The HTTP server and api.* layer pass
 * the resolved actor (`api_key:<key_id>` / `localhost:cli`) so audit events
 * land with one row per write, no double-emit.
 *
 * `opts.afterWrite` is invoked inside the same SAVEPOINT as the memories
 * INSERT (mirrors archiveRawMemory's shape in raw-archive.ts). On callback
 * throw, the SAVEPOINT rolls back — the memory row never lands, and the
 * filesystem mirrors / audit emit never run. Used by connectors to
 * stamp idempotency rows atomically with the memory write.
 */
/**
 * Stamp origin_project from the store's own location when the entry has
 * never been stamped (v39 memory scope isolation). The store dir is
 * `<project>/.hippo`, so its parent resolves to the owning project; the
 * home/global store resolves to '' (user-global). Callers that know a better
 * origin (shareMemory, syncGlobalToLocal) set entry.origin_project before
 * writing and this is a no-op. Returns a stamped copy; never mutates.
 *
 * NULL is deliberately PRESERVED, not re-stamped: null means "legacy row the
 * v39 migration found no evidence for" and is deny-by-default in ambient
 * context. A writeback (e.g. markRetrieved on a crossProject-included row)
 * must not launder it into an injectable origin - the migration is the only
 * evidence-based NULL converter.
 */
export function stampOriginProject(hippoRoot: string, entry: MemoryEntry): MemoryEntry {
  if (entry.origin_project !== undefined) return entry;
  return { ...entry, origin_project: deriveOriginProject(path.dirname(hippoRoot)) };
}

/**
 * Import-time variant for a mirror with no origin field (an explicit null stays null): used only where evidence exists
 * for rows that predate the origin column - the legacy-markdown bootstrap and
 * rebuildIndex import, which are the markdown-store equivalent of the v39 SQL
 * backfill. Same evidence order as the migration: the provenance source
 * (`shared:<project>:` / `promoted:<localRoot>`) wins over the destination
 * store's location, so a shared row imported into the global store keeps its
 * owning project instead of becoming user-global.
 */
export function stampOriginProjectForImport(hippoRoot: string, entry: MemoryEntry): MemoryEntry {
  if (entry.origin_project !== undefined) return entry;
  const fromSource = originFromSource(entry.source);
  return {
    ...entry,
    origin_project: fromSource ?? deriveOriginProject(path.dirname(hippoRoot)),
  };
}
