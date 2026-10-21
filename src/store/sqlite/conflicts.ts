// hippo.db's Conflicts group: listing and resolving the memory_conflicts rows.
import { ALL_TENANTS, DEFAULT_TENANT_ID, type TenantId } from '../../base/util/tenant.js';
import { withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { insertRejectedValue } from './rejection.js';
import { rejectionDigest, normalizeValueForRejection } from '../../base/records/rejection-digest.js';
import { archiveRawMemory } from './raw-archive.js';
import { MEMORY_CONFLICT_COLUMNS, type MemoryConflictRow, parseJsonArray, rowToMemoryConflict } from './rows.js';
import { audit } from './audit-event.js';
import { syncChangedMirrors, purgeMirrorBestEffort } from './mirrors.js';
import { selectEntriesByIds } from './entry-reads.js';
import { chunked } from '../../base/util/chunked.js';
import { ownScopeTouches } from '../../base/scope/recall-scope.js';
import type { StoreFiles, OnHandle } from './open.js';
import { deleteEntryCore } from './delete-and-batch.js';
import { keysetPage, type KeysetClause } from '../../base/util/keyset.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { DetectedConflict } from '../port/consolidation.js';
import type {
  ConflictListQuery,
  ConflictMember,
  ConflictResolution,
  ConflictRow,
  ConflictRowPage,
  LoserFate,
  Conflicts,
} from '../port/conflicts.js';
import { openStore } from './handles.js';
import type { Sync } from './served.js';
import { bound, boundWithFiles, type Bodies } from './bound.js';

// The JOIN with both members' memories rows needs each conflict column qualified, or `id` would be ambiguous.
const CONFLICT_COLS_MC = MEMORY_CONFLICT_COLUMNS.split(', ')
  .map((c) => `mc.${c}`)
  .join(', ');

function canonicalConflictPair(aId: string, bId: string): { memory_a_id: string; memory_b_id: string } {
  return aId < bId ? { memory_a_id: aId, memory_b_id: bId } : { memory_a_id: bId, memory_b_id: aId };
}

// Each member's columns the api's conflict rules read, aliased per side so one JOIN carries both.
const MEMBER_COLS = ['id', 'scope', 'kind', 'superseded_by', 'origin_project'] as const;
const memberCols = (alias: string, side: string): string =>
  MEMBER_COLS.map((c) => `${alias}.${c} AS ${side}_${c}`).join(', ');
const CONFLICT_ROW_COLS = `${CONFLICT_COLS_MC}, ${memberCols('ma', 'a')}, ${memberCols('mb', 'b')}`;

// SAFETY: every read cast to this row selects CONFLICT_ROW_COLS; scripts/check-row-casts.mjs proves it.
interface ConflictJoinRow extends MemoryConflictRow {
  a_id: string | null;
  a_scope: string | null;
  a_kind: string | null;
  a_superseded_by: string | null;
  a_origin_project: string | null;
  b_id: string | null;
  b_scope: string | null;
  b_kind: string | null;
  b_superseded_by: string | null;
  b_origin_project: string | null;
}

function memberOf(
  id: string | null,
  scope: string | null,
  kind: string | null,
  supersededBy: string | null,
  originProject: string | null,
): ConflictMember | null {
  if (id === null || kind === null) return null;
  return { scope, kind, superseded_by: supersededBy, origin_project: originProject };
}

function toConflictRow(r: ConflictJoinRow): ConflictRow {
  return {
    conflict: rowToMemoryConflict(r),
    a: memberOf(r.a_id, r.a_scope, r.a_kind, r.a_superseded_by, r.a_origin_project),
    b: memberOf(r.b_id, r.b_scope, r.b_kind, r.b_superseded_by, r.b_origin_project),
  };
}

/** A conflict read's SELECT with its WHERE. With a tenant both members must be in it, so no cross-tenant or stale pair
 * surfaces; with none, every conflict comes back with whichever members still exist. */
function conflictSelect(tenantId: TenantId, filters: readonly KeysetClause[]): KeysetClause {
  const join = tenantId === ALL_TENANTS ? 'LEFT JOIN' : 'JOIN';
  const where: KeysetClause[] =
    tenantId === ALL_TENANTS
      ? [...filters]
      : [{ sql: 'ma.tenant_id = ? AND mb.tenant_id = ?', params: [tenantId, tenantId] }, ...filters];
  return {
    sql:
      `SELECT ${CONFLICT_ROW_COLS} FROM memory_conflicts mc ${join} memories ma ON ma.id = mc.memory_a_id ` +
      `${join} memories mb ON mb.id = mc.memory_b_id` +
      (where.length > 0 ? ` WHERE ${where.map((f) => f.sql).join(' AND ')}` : ''),
    params: where.flatMap((f) => f.params),
  };
}

/** One page of conflicts, newest change first, each with both members' columns from the same JOIN. */
export function conflictPageAt(
  db: DatabaseSyncLike,
  { tenantId, status, limit, after }: ConflictListQuery,
): ConflictRowPage {
  const filters: KeysetClause[] = [];
  if (status !== '*') filters.push({ sql: 'mc.status = ?', params: [status] });
  if (after) filters.push({ sql: '(mc.updated_at, mc.id) < (?, ?)', params: [after.key, after.id] });
  const select = conflictSelect(tenantId, filters);
  const rows = cachedStatement(db, `${select.sql} ORDER BY mc.updated_at DESC, mc.id DESC LIMIT ?`).all(
    ...select.params,
    limit + 1,
  ) as ConflictJoinRow[];
  const page = keysetPage(rows, limit, (row) => ({ key: row.updated_at, id: row.id }));
  return { rows: page.rows.map(toConflictRow), next: page.next };
}

/** Conflict `conflictId`, any status, when both its members are in `tenantId`. */
function conflictByIdAt(db: DatabaseSyncLike, tenantId: string, conflictId: number): ConflictRow | null {
  const select = conflictSelect(tenantId, [{ sql: 'mc.id = ?', params: [conflictId] }]);
  const row = cachedStatement(db, select.sql).get(...select.params) as ConflictJoinRow | undefined;
  return row ? toConflictRow(row) : null;
}

// The tenanted open set: both members in the tenant.
const OPEN_IN_TENANT = `FROM memory_conflicts mc
  JOIN memories ma ON ma.id = mc.memory_a_id
  JOIN memories mb ON mb.id = mc.memory_b_id
  WHERE mc.status = 'open' AND ma.tenant_id = ? AND mb.tenant_id = ?`;

/** countOpenConflicts on a handle the caller holds, so it can share a snapshot with other reads. */
export function countOpenConflictsAt(db: DatabaseSyncLike, tenantId: string): number {
  // SAFETY: an aggregate with no GROUP BY always answers one row.
  const row = cachedStatement(db, `SELECT COUNT(*) AS n ${OPEN_IN_TENANT}`).get(tenantId, tenantId) as {
    n: number | bigint;
  };
  return Number(row.n);
}

/** The tenant's open conflicts naming `memoryId`, newest change first, each with both members' columns. */
export function openConflictsNamingAt(db: DatabaseSyncLike, tenantId: string, memoryId: string): ConflictRow[] {
  const select = conflictSelect(tenantId, [
    { sql: `mc.status = 'open'`, params: [] },
    { sql: '(mc.memory_a_id = ? OR mc.memory_b_id = ?)', params: [memoryId, memoryId] },
  ]);
  const rows = cachedStatement(db, `${select.sql} ORDER BY mc.updated_at DESC, mc.id DESC`).all(
    ...select.params,
  ) as ConflictJoinRow[];
  return rows.map(toConflictRow);
}

type SameTenant = (a: string, b: string) => boolean;

export function replaceDetectedConflictsAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  detected: Array<DetectedConflict>,
  detectedAt: string = new Date().toISOString(),
): void {
  const changedIds = writeConflictRefresh(db, readConflictRefresh(db, detected), detected, detectedAt);
  syncChangedMirrors(files.hippoRoot, db, [...selectEntriesByIds(db, changedIds, ALL_TENANTS).values()]);
}

/** The tenant of every memory the refresh can compare, and each stored conflicts_with_json other than '[]', read before
 * the refresh takes the write lock. */
interface ConflictRefreshReads {
  sameTenant: SameTenant;
  storedRefs: ReadonlyMap<string, string | null>;
}

/** The refresh's reads, kept out of the write lock; only rows holding refs, in an open conflict or in `detected` are
 * loaded, not the whole table. */
function readConflictRefresh(db: DatabaseSyncLike, detected: readonly DetectedConflict[]): ConflictRefreshReads {
  // Tenant guard: a conflict is meaningful only within one tenant, so cross-tenant pairs are skipped on insert and on
  // rebuild, and a stale cross-tenant row can neither persist nor leak a foreign id.
  const tenantById = new Map<string, string>();
  const storedRefs = new Map<string, string | null>();
  const rows = cachedStatement(
    db,
    `
    SELECT id, tenant_id, conflicts_with_json FROM memories
    WHERE conflicts_with_json != '[]'
      OR id IN (SELECT memory_a_id FROM memory_conflicts WHERE status = 'open')
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

/** Under the write lock: the memory_conflicts rows, then each memory whose refs change; returns the ids it rewrote. */
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
  const detectedKeys = new Set(canonicalDetected.map((conflict) => `${conflict.memory_a_id}::${conflict.memory_b_id}`));

  const openRows = db
    .prepare(`
    SELECT ${MEMORY_CONFLICT_COLUMNS}
    FROM memory_conflicts
    WHERE status = 'open'
  `)
    .all() as MemoryConflictRow[];

  const resolve = db.prepare(`UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id = ?`);
  for (const row of openRows) {
    const key = `${row.memory_a_id}::${row.memory_b_id}`;
    const stale = !detectedKeys.has(key);
    // Auto-resolve any open cross-tenant row: the insert loop and refMap rebuild skip those pairs, so re-detected ones
    // would linger as 'open'.
    const crossTenant = !sameTenant(row.memory_a_id, row.memory_b_id);
    if (stale || crossTenant) resolve.run(detectedAt, row.id);
  }
}

function upsertDetectedConflicts(
  db: DatabaseSyncLike,
  canonicalDetected: DetectedConflict[],
  sameTenant: SameTenant,
  detectedAt: string,
): void {
  const upsert = db.prepare(`
    INSERT INTO memory_conflicts(memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at)
    VALUES (?, ?, ?, ?, 'open', ?, ?)
    ON CONFLICT(memory_a_id, memory_b_id) DO UPDATE SET
      reason = excluded.reason,
      score = excluded.score,
      status = 'open',
      updated_at = excluded.updated_at
  `);
  for (const conflict of canonicalDetected) {
    // Skip cross-tenant pairs — never persist a conflict spanning tenants.
    if (!sameTenant(conflict.memory_a_id, conflict.memory_b_id)) continue;
    upsert.run(conflict.memory_a_id, conflict.memory_b_id, conflict.reason, conflict.score, detectedAt, detectedAt);
  }
}

/** Rewrites only the rows whose conflicts_with_json changes, and returns their ids. */
function rebuildConflictsWithJson(db: DatabaseSyncLike, { sameTenant, storedRefs }: ConflictRefreshReads): string[] {
  const openConflicts = db
    .prepare(`
    SELECT memory_a_id, memory_b_id
    FROM memory_conflicts
    WHERE status = 'open'
  `)
    .all() as Array<{ memory_a_id: string; memory_b_id: string }>;

  const refMap = new Map<string, Set<string>>();
  for (const row of openConflicts) {
    // Skip cross-tenant pairs so a stale row never seeds a foreign id into conflicts_with_json.
    if (!sameTenant(row.memory_a_id, row.memory_b_id)) continue;
    if (!refMap.has(row.memory_a_id)) refMap.set(row.memory_a_id, new Set());
    if (!refMap.has(row.memory_b_id)) refMap.set(row.memory_b_id, new Set());
    refMap.get(row.memory_a_id)!.add(row.memory_b_id);
    refMap.get(row.memory_b_id)!.add(row.memory_a_id);
  }

  // Only a row holding refs, or due some, can change. Compare-and-set, so a writer since the read keeps its value and
  // the next sleep redoes the row.
  const update = db.prepare(
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

/** Metadata shape of the `conflict_resolve` audit row; rejectedDigest is set only when the loser's value was also
 * tombstoned. */
interface ConflictResolveMeta {
  conflictId: number;
  keepId: string;
  loserId: string;
  disposition: string;
  rejected: boolean;
  removedIds: string[];
  rejectedDigest?: string;
}

// A side still in the tenant and still holding the scope the api decided on.
const SIDE_HOLDS = 'EXISTS (SELECT 1 FROM memories WHERE id = ? AND tenant_id = ? AND scope IS ?)';

/**
 * Marks the conflict resolved while it is open, names this pair and each side holds its scope; false writes nothing.
 */
function claimConflict(db: DatabaseSyncLike, tenantId: string, resolution: ConflictResolution): boolean {
  const { conflictId, keep, loser } = resolution;
  const pair = [keep.id, loser.id, loser.id, keep.id];
  const sides = [keep.id, tenantId, keep.scope, loser.id, tenantId, loser.scope];
  const claimed = cachedStatement(
    db,
    `UPDATE memory_conflicts SET status = 'resolved', updated_at = ? ` +
      `WHERE id = ? AND status = 'open' ` +
      `AND ((memory_a_id = ? AND memory_b_id = ?) OR (memory_a_id = ? AND memory_b_id = ?)) ` +
      `AND ${SIDE_HOLDS} AND ${SIDE_HOLDS}`,
  ).run(resolution.at, conflictId, ...pair, ...sides);
  return Number(claimed.changes ?? 0) > 0;
}

/** Keeps `keep` and weakens, removes or rejects `loser` as the api decided, with one `conflict_resolve` audit row;
 * false when another resolver got there first or a side moved since the api read it. */
function resolveConflictAt(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  resolution: ConflictResolution,
): boolean {
  const removal = withWriteScope(db, 'resolve_conflict', () => {
    if (!claimConflict(db, tenantId, resolution)) return null;
    const { fate } = resolution;
    const out =
      fate.kind === 'weaken'
        ? weakenConflictLoser(db, tenantId, resolution.loser.id, fate)
        : removeConflictLoser(db, tenantId, resolution);
    stripConflictRefs(db, tenantId, resolution, out.loserRemoved);
    auditConflictResolve(db, tenantId, resolution, out);
    return out;
  });
  if (removal === null) return false;
  const { keep, loser } = resolution;
  syncChangedMirrors(files.hippoRoot, db, [...selectEntriesByIds(db, [keep.id, loser.id], tenantId).values()]);
  if (removal.loserRemoved) purgeRemovedLoserMirrors(files.hippoRoot, db, loser.id, removal);
  return true;
}

/** What removing the loser did; drives the conflicts_with_json skip, the audit row and the mirror purge. */
interface LoserRemoval {
  loserRemoved: boolean;
  loserWasRaw: boolean;
  rejectedDigest: string | undefined;
  extraRemovedIds: string[];
  extraRemovedRawIds: string[];
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
interface LoserRow {
  kind: string;
  content: string;
  tenant_id: string;
}

function emptyRemoval(): LoserRemoval {
  return {
    loserRemoved: false,
    loserWasRaw: false,
    rejectedDigest: undefined,
    extraRemovedIds: [],
    extraRemovedRawIds: [],
  };
}

type WeakenFate = Extract<LoserFate, { kind: 'weaken' }>;

function weakenConflictLoser(db: DatabaseSyncLike, tenantId: string, loserId: string, fate: WeakenFate): LoserRemoval {
  cachedStatement(
    db,
    `UPDATE memories SET half_life_days = MAX(?, half_life_days * ?), updated_at = datetime('now') ` +
      `WHERE id = ? AND tenant_id = ?`,
  ).run(fate.minHalfLifeDays, fate.halfLifeFactor, loserId, tenantId);
  return emptyRemoval();
}

function removeConflictLoser(db: DatabaseSyncLike, tenantId: string, r: ConflictResolution): LoserRemoval {
  // Removal is kind-aware: a bare DELETE on a raw loser fires the append-only trigger, so use the same helpers as the
  // reject verb.
  const removal = emptyRemoval();
  const loserId = r.loser.id;
  const loserRow = cachedStatement(
    db,
    `SELECT kind, content, tenant_id FROM memories WHERE id = ? AND tenant_id = ?`,
  ).get(loserId, tenantId) as LoserRow | undefined;
  // The claim in this transaction saw the row, so it is there.
  if (!loserRow) return removal;
  if (r.fate.kind === 'reject') {
    removal.rejectedDigest = tombstoneLoserValue(db, { r, ownScope: r.fate.ownScope, loserRow, removal });
  }
  if (loserRow.kind === 'raw') {
    archiveRawMemory(db, loserId, { reason: r.reason, who: r.actor });
    removal.loserWasRaw = true;
  } else {
    deleteEntryCore(db, loserId, loserRow.tenant_id, { actor: r.actor, suppressForgetAudit: true });
  }
  removal.loserRemoved = true;
  return removal;
}

function recordRejectedLoserValue(
  db: DatabaseSyncLike,
  r: ConflictResolution,
  loserRow: LoserRow,
  digest: string,
): void {
  insertRejectedValue(db, {
    tenantId: loserRow.tenant_id ?? DEFAULT_TENANT_ID,
    digest,
    reason: r.reason,
    rejectedBy: r.actor,
    rejectedAt: r.at,
    sourceMemoryId: r.loser.id,
    normalizedChars: normalizeValueForRejection(loserRow.content).length,
  });
}

/** A loser whose value is rejected: its row, the scope its duplicates are swept in, and the removal they go into. */
interface RejectedLoser {
  readonly r: ConflictResolution;
  readonly ownScope: string | null;
  readonly loserRow: LoserRow;
  readonly removal: LoserRemoval;
}

/** Removes the live same-tenant rows `ownScope` may touch whose digest matches the rejected value into `removal`;
 * `keep` is spared. */
function removeDuplicatesOfRejectedValue(
  db: DatabaseSyncLike,
  { r, ownScope, loserRow, removal }: RejectedLoser,
  rejectedDigest: string,
): void {
  // Every live same-tenant row holding the value goes, as `hippo reject` does; `keep` stays because the human chose it.
  const loserTenantId = loserRow.tenant_id ?? DEFAULT_TENANT_ID;
  // SHORTCUT: streams the tenant to hold only the matches; a stored digest column with a (tenant_id, digest) index
  // would read just those.
  const dupRows = cachedStatement(
    db,
    `SELECT id, kind, content, scope FROM memories WHERE tenant_id = ? AND id != ? AND id != ?`,
  ).iterate(loserTenantId, r.loser.id, r.keep.id) as Iterable<{
    id: string;
    kind: string;
    content: string;
    scope: string | null;
  }>;
  const dups: Array<{ id: string; kind: string }> = [];
  for (const dup of dupRows) {
    if (rejectionDigest(dup.content) !== rejectedDigest || !ownScopeTouches(ownScope, dup.scope)) continue;
    dups.push({ id: dup.id, kind: dup.kind });
  }
  const { actor, reason } = r;
  // Removed after the read ends, since deleting rows under an open cursor can skip or repeat rows.
  for (const dup of dups) {
    if (dup.kind === 'raw') {
      archiveRawMemory(db, dup.id, { reason, who: actor });
      removal.extraRemovedRawIds.push(dup.id);
    } else {
      deleteEntryCore(db, dup.id, loserTenantId, { actor, suppressForgetAudit: true });
    }
    removal.extraRemovedIds.push(dup.id);
  }
}

/** Tombstones the loser's digest and removes its same-tenant duplicates into `removal`; returns the digest. */
function tombstoneLoserValue(db: DatabaseSyncLike, loser: RejectedLoser): string {
  const rejectedDigest = rejectionDigest(loser.loserRow.content);
  recordRejectedLoserValue(db, loser.r, loser.loserRow, rejectedDigest);
  removeDuplicatesOfRejectedValue(db, loser, rejectedDigest);
  return rejectedDigest;
}

/** Drops `ref` from row `id`'s conflicts_with_json, when the row is in the tenant. */
function dropConflictRef(db: DatabaseSyncLike, tenantId: string, id: string, ref: string): void {
  const row = cachedStatement(db, `SELECT conflicts_with_json FROM memories WHERE id = ? AND tenant_id = ?`).get(
    id,
    tenantId,
  ) as { conflicts_with_json: string } | undefined;
  if (!row) return;
  const refs = parseJsonArray(row.conflicts_with_json, { table: 'memories', id, column: 'conflicts_with_json' });
  cachedStatement(
    db,
    `UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`,
  ).run(JSON.stringify(refs.filter((r: string) => r !== ref)), id, tenantId);
}

function stripConflictRefs(db: DatabaseSyncLike, tenantId: string, r: ConflictResolution, loserRemoved: boolean): void {
  dropConflictRef(db, tenantId, r.keep.id, r.loser.id);
  if (!loserRemoved) dropConflictRef(db, tenantId, r.loser.id, r.keep.id);
}

function auditConflictResolve(
  db: DatabaseSyncLike,
  tenantId: string,
  r: ConflictResolution,
  removal: LoserRemoval,
): void {
  const { loserRemoved, loserWasRaw, rejectedDigest, extraRemovedIds } = removal;
  // Every path (weaken, forget, reject) lands exactly one conflict_resolve audit row.
  const conflictResolveMeta: ConflictResolveMeta = {
    conflictId: r.conflictId,
    keepId: r.keep.id,
    loserId: r.loser.id,
    disposition: loserRemoved ? (loserWasRaw ? 'archived_raw' : 'deleted') : 'weakened',
    rejected: r.fate.kind === 'reject',
    // Every row this call removed, not just loserId, so the duplicate sweep (extraRemovedIds) is audited too.
    removedIds: loserRemoved ? [r.loser.id, ...extraRemovedIds] : [],
  };
  // Assigned only when present so the serialized audit payload keeps omitting the key, exactly as the pre-migration
  // object literal did.
  if (rejectedDigest !== undefined) conflictResolveMeta.rejectedDigest = rejectedDigest;
  // Fresh spread literal: ConflictResolveMeta is a closed interface, not assignable to audit()'s Record<string,
  // JsonValue> metadata otherwise.
  audit(db, 'conflict_resolve', {
    targetId: r.keep.id,
    metadata: { ...conflictResolveMeta },
    actor: r.actor,
    tenantId,
  });
}

function purgeRemovedLoserMirrors(
  hippoRoot: string,
  db: DatabaseSyncLike,
  loserId: string,
  removal: LoserRemoval,
): void {
  // Mirror purge and reaper stamp for EVERY removed loser (loserId and each extraRemovedIds duplicate), post-commit
  // like the reject verb.
  // A non-raw mirror has no reaper, so skipping the purge would orphan it forever.
  for (const removedId of [loserId, ...removal.extraRemovedIds]) {
    const isRaw = removedId === loserId ? removal.loserWasRaw : removal.extraRemovedRawIds.includes(removedId);
    // purgeMirrorBestEffort retries once, then reports the explicit leftover paths for non-raw ids, which the
    // cleanupArchivedMirrors reaper never scans.
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, removedId, isRaw, 'resolveConflict');
    if (mirrorOk && isRaw) {
      cachedStatement(db, `UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
        new Date().toISOString(),
        removedId,
      );
    }
  }
}

/** The conflict and loser ids every conflict_resolve audit row names. */
export function conflictResolveAuditsAt(db: DatabaseSyncLike): Array<{ conflictId: number; loserId: string }> {
  // SAFETY: every conflict_resolve audit row's metadata holds both ids (ConflictResolveMeta above).
  return db
    .prepare(
      `SELECT json_extract(metadata_json, '$.conflictId') ` +
        `AS conflictId, json_extract(metadata_json, '$.loserId') AS loserId ` +
        `FROM audit_log WHERE op = 'conflict_resolve'`,
    )
    .all() as { conflictId: number; loserId: string }[];
}

/** Every resolved conflict with both sides. */
export function resolvedConflictsAt(
  db: DatabaseSyncLike,
): Array<{ id: number; memory_a_id: string; memory_b_id: string }> {
  return db.prepare(`SELECT id, memory_a_id, memory_b_id FROM memory_conflicts WHERE status = 'resolved'`).all() as {
    id: number;
    memory_a_id: string;
    memory_b_id: string;
  }[];
}

const conflictsAt: Bodies<Omit<Conflicts, 'resolve'>> = { list: conflictPageAt, get: conflictByIdAt };

export function sqliteConflicts(on: OnHandle): Sync<Conflicts> {
  return {
    ...bound(on, conflictsAt, openStore),
    ...boundWithFiles<Pick<Conflicts, 'resolve'>>(on, { resolve: resolveConflictAt }, openStore),
  };
}
