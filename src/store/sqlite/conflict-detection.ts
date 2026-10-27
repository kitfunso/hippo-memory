// hippo.db's conflict refresh: writes the detected conflicts and each memory's conflicts_with_json.
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { syncChangedMirrors } from './mirrors.js';
import { readEntriesByIds } from './entry-reads.js';
import { chunked } from '../../base/util/chunked.js';
import type { StoreFiles } from './open.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { DetectedConflict } from '../../base/ports/store/consolidation.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import { handleStamp } from './handle-clock.js';
import { canonicalConflictPair } from './conflicts.js';
type SameTenant = (a: string, b: string) => boolean;

export function replaceDetectedConflicts(
  db: DatabaseSyncLike,
  files: StoreFiles,
  detected: Array<DetectedConflict>,
  detectedAt: string = handleStamp(db),
): void {
  const changedIds = writeConflictRefresh(
    db,
    readConflictRefresh(db, detected),
    detected,
    detectedAt,
  );
  const changed = [...readEntriesByIds(db, changedIds, ALL_TENANTS).values()];
  syncChangedMirrors(files, db, changed, detectedAt);
}

/** The tenant of every memory the refresh can compare, and each stored conflicts_with_json other
 * than '[]', read before the refresh takes the write lock. */
interface ConflictRefreshReads {
  sameTenant: SameTenant;
  storedRefs: ReadonlyMap<string, string | null>;
}

/** The refresh's reads, kept out of the write lock; only rows holding refs, in an open conflict
 * or in `detected` are loaded, not the whole table. */
function readConflictRefresh(
  db: DatabaseSyncLike,
  detected: readonly DetectedConflict[],
): ConflictRefreshReads {
  // Tenant guard: a conflict is meaningful only within one tenant, so cross-tenant pairs are
  // skipped on insert and on rebuild, and a stale cross-tenant row can neither persist nor leak a
  // foreign id.
  const tenantById = new Map<string, string>();
  const storedRefs = new Map<string, string | null>();
  // A UNION, not one OR: SQLite plans that OR as a scan of every memory, while each arm here reads
  // an index.
  const rows = cachedStatement(
    db,
    `
    SELECT id, tenant_id, conflicts_with_json FROM memories WHERE conflicts_with_json != '[]'
    UNION
    SELECT id, tenant_id, conflicts_with_json FROM memories
    WHERE id IN (SELECT memory_a_id FROM memory_conflicts WHERE status = 'open')
      OR id IN (SELECT memory_b_id FROM memory_conflicts WHERE status = 'open')
  `,
  ).all() as Array<{ id: string; tenant_id: string; conflicts_with_json: string | null }>;
  for (const r of rows) {
    tenantById.set(r.id, r.tenant_id);
    if (r.conflicts_with_json !== '[]') storedRefs.set(r.id, r.conflicts_with_json);
  }
  const given = [...new Set(detected.flatMap((c) => [c.memory_a_id, c.memory_b_id]))].filter(
    (id) => !tenantById.has(id),
  );
  for (const ids of chunked(given)) {
    const found = cachedStatement(
      db,
      `SELECT id, tenant_id FROM memories WHERE id IN (SELECT value FROM json_each(?))`,
    ).all(JSON.stringify(ids)) as Array<{
      id: string;
      tenant_id: string;
    }>;
    for (const r of found) tenantById.set(r.id, r.tenant_id);
  }
  const sameTenant = (a: string, b: string): boolean => {
    const ta = tenantById.get(a);
    const tb = tenantById.get(b);
    return ta !== undefined && tb !== undefined && ta === tb;
  };
  return { sameTenant, storedRefs };
}

/** Under the write lock: the memory_conflicts rows, then each memory whose refs change; returns
 * the ids it rewrote. */
function writeConflictRefresh(
  db: DatabaseSyncLike,
  reads: ConflictRefreshReads,
  detected: readonly DetectedConflict[],
  detectedAt: string,
): string[] {
  const canonicalDetected = detected.map((conflict) => ({
    ...canonicalConflictPair(conflict.memory_a_id, conflict.memory_b_id),
    reason: conflict.reason,
    score: conflict.score,
  }));
  return withWriteScope(db, 'replace_conflicts', () => {
    resolveStaleOpenConflicts(db, canonicalDetected, reads.sameTenant, detectedAt);
    upsertDetectedConflicts(db, canonicalDetected, reads.sameTenant, detectedAt);
    return rebuildConflictsWithJson(db, reads);
  });
}

function resolveStaleOpenConflicts(
  db: DatabaseSyncLike,
  canonicalDetected: DetectedConflict[],
  sameTenant: SameTenant,
  detectedAt: string,
): void {
  const detectedKeys = new Set(
    canonicalDetected.map((conflict) => `${conflict.memory_a_id}::${conflict.memory_b_id}`),
  );

  let after = 0;
  for (;;) {
    // SAFETY: id is the keyset cursor; the two member ids decide whether the row is stale.
    const page = cachedStatement(
      db,
      `SELECT id, memory_a_id, memory_b_id FROM memory_conflicts WHERE status = 'open' AND id > ? ORDER BY id LIMIT ?`,
    ).all(after, READ_PAGE_ROWS) as Array<{ id: number; memory_a_id: string; memory_b_id: string }>;
    // Auto-resolve any open cross-tenant row: the insert loop and refMap rebuild skip those pairs,
    // so re-detected ones would linger as 'open'.
    const resolved = page.filter(
      (row) =>
        !detectedKeys.has(`${row.memory_a_id}::${row.memory_b_id}`) ||
        !sameTenant(row.memory_a_id, row.memory_b_id),
    );
    if (resolved.length > 0) {
      cachedStatement(
        db,
        `UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`,
      ).run(detectedAt, JSON.stringify(resolved.map((row) => row.id)));
    }
    if (page.length < READ_PAGE_ROWS) return;
    after = page[page.length - 1].id;
  }
}

function upsertDetectedConflicts(
  db: DatabaseSyncLike,
  canonicalDetected: DetectedConflict[],
  sameTenant: SameTenant,
  detectedAt: string,
): void {
  const upsert = cachedStatement(
    db,
    `
    INSERT INTO memory_conflicts(memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?)
    ON CONFLICT(memory_a_id, memory_b_id) DO UPDATE SET
      reason = excluded.reason,
      score = excluded.score,
      status = 'open',
      updated_at = excluded.updated_at
  `,
  );
  for (const conflict of canonicalDetected) {
    // Skip cross-tenant pairs — never persist a conflict spanning tenants.
    if (!sameTenant(conflict.memory_a_id, conflict.memory_b_id)) continue;
    upsert.run(
      conflict.memory_a_id,
      conflict.memory_b_id,
      conflict.reason,
      conflict.score,
      detectedAt,
      detectedAt,
    );
  }
}

/** Rewrites only the rows whose conflicts_with_json changes, and returns their ids. */
function rebuildConflictsWithJson(
  db: DatabaseSyncLike,
  { sameTenant, storedRefs }: ConflictRefreshReads,
): string[] {
  const openConflicts = cachedStatement(
    db,
    `SELECT memory_a_id, memory_b_id FROM memory_conflicts WHERE status = 'open'`,
  ).all() as Array<{ memory_a_id: string; memory_b_id: string }>;

  const refMap = new Map<string, Set<string>>();
  for (const row of openConflicts) {
    // Skip cross-tenant pairs so a stale row never seeds a foreign id into conflicts_with_json.
    if (!sameTenant(row.memory_a_id, row.memory_b_id)) continue;
    if (!refMap.has(row.memory_a_id)) refMap.set(row.memory_a_id, new Set());
    if (!refMap.has(row.memory_b_id)) refMap.set(row.memory_b_id, new Set());
    refMap.get(row.memory_a_id)!.add(row.memory_b_id);
    refMap.get(row.memory_b_id)!.add(row.memory_a_id);
  }

  // Only a row holding refs, or due some, can change. Compare-and-set, so a writer since the read
  // keeps its value and the next sleep redoes the row.
  const update = cachedStatement(
    db,
    `UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') ` +
      `WHERE id = ? AND conflicts_with_json IS ?`,
  );
  const changedIds: string[] = [];
  for (const id of new Set([...storedRefs.keys(), ...refMap.keys()])) {
    const stored = storedRefs.has(id) ? (storedRefs.get(id) ?? null) : '[]';
    const refsJson = JSON.stringify(Array.from(refMap.get(id) ?? []).sort());
    if (stored === refsJson) continue;
    if (Number(update.run(refsJson, id, stored).changes ?? 0) > 0) changedIds.push(id);
  }
  return changedIds;
}
