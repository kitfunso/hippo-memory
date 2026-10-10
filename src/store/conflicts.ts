import { DEFAULT_TENANT_ID } from '../util/env.js';
import { closeHippoDb, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import type { MemoryEntry } from '../core/memory.js';
import { rejectionDigest, insertRejectedValue, normalizeValueForRejection } from './rejection.js';
import { archiveRawMemory } from './raw-archive.js';
import { type MemoryConflict, type MemoryConflictRow, rowToMemoryConflict } from './rows.js';
import { audit } from './audit-event.js';
import { syncChangedMirrors, purgeMirrorBestEffort } from './mirrors.js';
import { selectEntriesByIds } from './entry-reads.js';
import { chunked } from '../util/chunked.js';
import { onHandle, openStore } from './open.js';
import { deleteEntryCore } from './delete-and-batch.js';
import { BadRequestError } from '../core/api-errors.js';
import { canTouchScope, isPersonalScope } from '../core/recall-scope.js';
import { selectMemoryReach } from './tenant-lookup.js';

// The one place MemoryConflictRow's columns are listed; CONFLICT_COLS_MC is the same list under the `mc` alias.
const CONFLICT_COLS = 'id, memory_a_id, memory_b_id, reason, score, status, detected_at, updated_at';
const CONFLICT_COLS_MC = CONFLICT_COLS.split(', ').map((c) => `mc.${c}`).join(', ');

function canonicalConflictPair(aId: string, bId: string): { memory_a_id: string; memory_b_id: string } {
  return aId < bId
    ? { memory_a_id: aId, memory_b_id: bId }
    : { memory_a_id: bId, memory_b_id: aId };
}

function selectConflictRowsInTenant(db: DatabaseSyncLike, status: string, allStatuses: boolean, tenantId: string): MemoryConflictRow[] {
  // Tenanted query: JOIN memories on both members and require each in-tenant, so no cross-tenant or stale pre-fix pair surfaces.
  // SAFETY: both branches select CONFLICT_COLS_MC, MemoryConflictRow's columns.
  return allStatuses
    ? db.prepare(`
        SELECT ${CONFLICT_COLS_MC}
        FROM memory_conflicts mc
        JOIN memories ma ON ma.id = mc.memory_a_id
        JOIN memories mb ON mb.id = mc.memory_b_id
        WHERE ma.tenant_id = ? AND mb.tenant_id = ?
        ORDER BY mc.updated_at DESC, mc.id DESC
      `).all(tenantId, tenantId) as MemoryConflictRow[]
    : db.prepare(`
        SELECT ${CONFLICT_COLS_MC}
        FROM memory_conflicts mc
        JOIN memories ma ON ma.id = mc.memory_a_id
        JOIN memories mb ON mb.id = mc.memory_b_id
        WHERE mc.status = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
        ORDER BY mc.updated_at DESC, mc.id DESC
      `).all(status, tenantId, tenantId) as MemoryConflictRow[];
}

function selectConflictRowsUnscoped(db: DatabaseSyncLike, status: string, allStatuses: boolean): MemoryConflictRow[] {
  // Unscoped query — legacy direct-mode (CLI, tests, consolidate).
  // SAFETY: both branches select CONFLICT_COLS, MemoryConflictRow's columns.
  return allStatuses
    ? db.prepare(`
        SELECT ${CONFLICT_COLS}
        FROM memory_conflicts
        ORDER BY updated_at DESC, id DESC
      `).all() as MemoryConflictRow[]
    : db.prepare(`
        SELECT ${CONFLICT_COLS}
        FROM memory_conflicts
        WHERE status = ?
        ORDER BY updated_at DESC, id DESC
      `).all(status) as MemoryConflictRow[];
}

export function listMemoryConflicts(
  hippoRoot: string,
  status: string = 'open',
  tenantId?: string,
): MemoryConflict[] {
  return onHandle(hippoRoot, (db) => {
    // '*' is a sentinel for no status filter; the 4 SQL branches below cover {tenanted | unscoped} x {all-statuses | specific-status}.
    const allStatuses = status === '*';
    const rows = tenantId !== undefined
      ? selectConflictRowsInTenant(db, status, allStatuses, tenantId)
      : selectConflictRowsUnscoped(db, status, allStatuses);
    return rows.map(rowToMemoryConflict);
  }, openStore);
}

// listMemoryConflicts' tenanted open set: both members in the tenant.
const OPEN_IN_TENANT = `FROM memory_conflicts mc
  JOIN memories ma ON ma.id = mc.memory_a_id
  JOIN memories mb ON mb.id = mc.memory_b_id
  WHERE mc.status = 'open' AND ma.tenant_id = ? AND mb.tenant_id = ?`;

/** How many open conflicts listMemoryConflicts returns for a tenant, without loading one. */
export function countOpenConflicts(hippoRoot: string, tenantId: string): number {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: one row with the single aliased count column.
    const row = db.prepare(`SELECT COUNT(*) AS n ${OPEN_IN_TENANT}`).get(tenantId, tenantId) as { n: number | bigint };
    return Number(row.n);
  }, openStore);
}

/** One open conflict of a memory, with the row on its other side. */
export interface OpenConflictOf {
  conflict: MemoryConflict;
  other: MemoryEntry;
}

/** A tenant's open conflicts naming `memoryId`, in listMemoryConflicts' order, each with its other member read in one batch. */
export function loadOpenConflictsOf(hippoRoot: string, tenantId: string, memoryId: string): OpenConflictOf[] {
  return onHandle(hippoRoot, (db) => {
    // SAFETY: selects CONFLICT_COLS_MC, MemoryConflictRow's columns.
    const rows = db.prepare(
      `SELECT ${CONFLICT_COLS_MC}
       ${OPEN_IN_TENANT} AND (mc.memory_a_id = ? OR mc.memory_b_id = ?)
       ORDER BY mc.updated_at DESC, mc.id DESC`,
    ).all(tenantId, tenantId, memoryId, memoryId) as MemoryConflictRow[];
    const conflicts = rows.map(rowToMemoryConflict);
    const otherId = (c: MemoryConflict): string => (c.memory_a_id === memoryId ? c.memory_b_id : c.memory_a_id);
    const others = selectEntriesByIds(db, conflicts.map(otherId), tenantId);
    const out: OpenConflictOf[] = [];
    for (const conflict of conflicts) {
      const other = others.get(otherId(conflict));
      if (other) out.push({ conflict, other });
    }
    return out;
  }, openStore);
}

/** Conflicts whose two rows `actor` may both touch; someone else's personal row hides its whole pair. */
export function listTouchableConflicts(hippoRoot: string, status: string, tenantId: string, actor: { owner?: string }): MemoryConflict[] {
  const conflicts = listMemoryConflicts(hippoRoot, status, tenantId);
  return onHandle(hippoRoot, (db) => {
    return conflicts.filter((c) => [c.memory_a_id, c.memory_b_id].every((id) => canTouchScope(actor, selectMemoryReach(db, id)?.scope ?? null)));
  });
}

type DetectedConflict = { memory_a_id: string; memory_b_id: string; reason: string; score: number };
type SameTenant = (a: string, b: string) => boolean;

export function replaceDetectedConflicts(
  hippoRoot: string,
  detected: Array<DetectedConflict>,
  detectedAt: string = new Date().toISOString()
): void {
  onHandle(hippoRoot, (db) => {
    const changedIds = writeConflictRefresh(db, readConflictRefresh(db, detected), detected, detectedAt);
    syncChangedMirrors(hippoRoot, db, [...selectEntriesByIds(db, changedIds).values()]);
  }, openStore);
}

/** The tenant of every memory the refresh can compare, and each stored conflicts_with_json other than '[]', read before the refresh takes the write lock. */
export interface ConflictRefreshReads {
  sameTenant: SameTenant;
  storedRefs: ReadonlyMap<string, string | null>;
}

/** The refresh's reads, kept out of the write lock; only rows holding refs, in an open conflict or in `detected` are loaded, not the whole table. */
function readConflictRefresh(db: DatabaseSyncLike, detected: readonly DetectedConflict[]): ConflictRefreshReads {
  // Tenant guard (E2): a conflict is meaningful only within one tenant, so cross-tenant pairs are
  // skipped on insert and on rebuild, and a stale cross-tenant row can neither persist nor leak a foreign id.
  const tenantById = new Map<string, string>();
  const storedRefs = new Map<string, string | null>();
  // SAFETY: rows' shape matches the three columns named in the SELECT.
  const rows = db.prepare(`
    SELECT id, tenant_id, conflicts_with_json FROM memories
    WHERE conflicts_with_json != '[]'
      OR id IN (SELECT memory_a_id FROM memory_conflicts WHERE status = 'open')
      OR id IN (SELECT memory_b_id FROM memory_conflicts WHERE status = 'open')
  `).all() as Array<{ id: string; tenant_id: string; conflicts_with_json: string | null }>;
  for (const r of rows) {
    tenantById.set(r.id, r.tenant_id);
    if (r.conflicts_with_json !== '[]') storedRefs.set(r.id, r.conflicts_with_json);
  }
  const given = [...new Set(detected.flatMap((c) => [c.memory_a_id, c.memory_b_id]))].filter((id) => !tenantById.has(id));
  for (const ids of chunked(given)) {
    const marks = ids.map(() => '?').join(',');
    // SAFETY: rows' shape matches the two columns named in the SELECT.
    const found = db.prepare(`SELECT id, tenant_id FROM memories WHERE id IN (${marks})`).all(...ids) as Array<{ id: string; tenant_id: string }>;
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

  // SAFETY: openRows' shape matches the columns named in CONFLICT_COLS.
  const openRows = db.prepare(`
    SELECT ${CONFLICT_COLS}
    FROM memory_conflicts
    WHERE status = 'open'
  `).all() as MemoryConflictRow[];

  const resolve = db.prepare(`UPDATE memory_conflicts SET status = 'resolved', updated_at = ? WHERE id = ?`);
  for (const row of openRows) {
    const key = `${row.memory_a_id}::${row.memory_b_id}`;
    const stale = !detectedKeys.has(key);
    // Auto-resolve any open cross-tenant row: the insert loop and refMap rebuild skip those pairs, so re-detected ones would linger as 'open'.
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
function rebuildConflictsWithJson(db: DatabaseSyncLike, { sameTenant, storedRefs }: ConflictRefreshReads): string[] {
  // SAFETY: openConflicts' shape matches the two columns named above.
  const openConflicts = db.prepare(`
    SELECT memory_a_id, memory_b_id
    FROM memory_conflicts
    WHERE status = 'open'
  `).all() as Array<{ memory_a_id: string; memory_b_id: string }>;

  const refMap = new Map<string, Set<string>>();
  for (const row of openConflicts) {
    // Skip cross-tenant pairs so a stale row never seeds a foreign id
    // into conflicts_with_json.
    if (!sameTenant(row.memory_a_id, row.memory_b_id)) continue;
    if (!refMap.has(row.memory_a_id)) refMap.set(row.memory_a_id, new Set());
    if (!refMap.has(row.memory_b_id)) refMap.set(row.memory_b_id, new Set());
    refMap.get(row.memory_a_id)!.add(row.memory_b_id);
    refMap.get(row.memory_b_id)!.add(row.memory_a_id);
  }

  // Only a row holding refs, or due some, can change. Compare-and-set, so a writer since the read keeps its value and the next sleep redoes the row.
  const update = db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ? AND conflicts_with_json IS ?`);
  const changedIds: string[] = [];
  for (const id of new Set([...storedRefs.keys(), ...refMap.keys()])) {
    const stored = storedRefs.has(id) ? storedRefs.get(id) ?? null : '[]';
    const refsJson = JSON.stringify(Array.from(refMap.get(id) ?? []).sort());
    if (stored === refsJson) continue;
    if (Number(update.run(refsJson, id, stored).changes ?? 0) > 0) changedIds.push(id);
  }
  return changedIds;
}

/** `rejectLoserValue` implies removal of the loser regardless of `forgetLoser`: a tombstoned value cannot stay live. */
export interface ResolveConflictOpts {
  /** Tombstone the loser's normalized digest + kind-aware remove it. */
  rejectLoserValue?: boolean;
  /** Actor for the tombstone + the new conflict_resolve audit row. Defaults to 'cli'. */
  rejectedBy?: string;
  /** Reason recorded on the tombstone (and passed to archiveRawMemory if the
   *  loser is kind='raw'). Defaults to a conflict-context string. */
  reason?: string;
}

/** Metadata shape of the `conflict_resolve` audit row; rejectedDigest is set only when the loser's value was also tombstoned. */
interface ConflictResolveMeta {
  conflictId: number;
  keepId: string;
  loserId: string;
  disposition: string;
  rejected: boolean;
  removedIds: string[];
  rejectedDigest?: string;
}

// With tenantId, both members must be in-tenant and every memories mutation carries AND tenant_id = ?; a cross-tenant probe returns null like a bad id.
// Omitted tenantId = unscoped (CLI direct mode, tests).
function conflictMemScope(tenantId?: string): MemScope {
  return {
    memScope: tenantId !== undefined ? ' AND tenant_id = ?' : '',
    memArgs: tenantId !== undefined ? [tenantId] : [],
  };
}

function findResolvableConflict(
  db: DatabaseSyncLike,
  conflictId: number,
  keepId: string,
  tenantId?: string,
): { conflict: MemoryConflict; loserId: string } | null {
  const row = selectConflictRow(db, conflictId, tenantId);
  if (!row) return null;

  const conflict = rowToMemoryConflict(row);
  if (conflict.status !== 'open') return null;

  const loserId = keepId === conflict.memory_a_id
    ? conflict.memory_b_id
    : keepId === conflict.memory_b_id
      ? conflict.memory_a_id
      : null;

  if (!loserId) return null;
  return { conflict, loserId };
}

/** Resolve a conflict by keeping one memory and halving the loser's half-life; `--forget` removes the loser, `opts.rejectLoserValue` also tombstones its
 * digest. Every path emits a `conflict_resolve` audit row. Returns the resolved conflict, or null if not found. */
export function resolveConflict(
  hippoRoot: string,
  conflictId: number,
  keepId: string,
  forgetLoser: boolean = false,
  tenantId?: string,
  opts?: ResolveConflictOpts,
): { conflict: MemoryConflict; loserId: string } | null {
  const db = openStore(hippoRoot);
  const scope = conflictMemScope(tenantId);

  try {
    const resolvable = findResolvableConflict(db, conflictId, keepId, tenantId);
    if (!resolvable) return null;
    const { conflict, loserId } = resolvable;

    const target: ResolveTarget = { conflictId, keepId, loserId, scope, opts };
    const removal = withWriteScope(db, 'resolve_conflict', () => {
      // Mark conflict as resolved
      db.prepare(`UPDATE memory_conflicts SET status = 'resolved', updated_at = datetime('now') WHERE id = ?`)
        .run(conflictId);

      const removeLoser = forgetLoser || opts?.rejectLoserValue === true;
      const out = removeLoser ? removeConflictLoser(db, target) : weakenConflictLoser(db, target);

      stripConflictRefs(db, target, out.loserRemoved);
      auditConflictResolve(db, target, out, tenantId);
      return out;
    });
    syncChangedMirrors(hippoRoot, db, [...selectEntriesByIds(db, [keepId, loserId]).values()]);

    if (removal.loserRemoved) purgeRemovedLoserMirrors(hippoRoot, db, loserId, removal);

    return { conflict: { ...conflict, status: 'resolved' }, loserId };
  } finally {
    closeHippoDb(db);
  }
}

interface MemScope {
  memScope: string;
  memArgs: string[];
}

interface ResolveTarget {
  conflictId: number;
  keepId: string;
  loserId: string;
  scope: MemScope;
  opts: ResolveConflictOpts | undefined;
}

/** What removing the loser did; drives the conflicts_with_json skip, the audit row and the mirror purge. */
interface LoserRemoval {
  loserRemoved: boolean;
  loserWasRaw: boolean;
  rejectedDigest: string | undefined;
  extraRemovedIds: string[];
  extraRemovedRawIds: string[];
}

function selectConflictRow(
  db: DatabaseSyncLike,
  conflictId: number,
  tenantId: string | undefined,
): MemoryConflictRow | undefined {
  // SAFETY: the branches select CONFLICT_COLS_MC and CONFLICT_COLS, MemoryConflictRow's columns.
  return (tenantId !== undefined
    ? db.prepare(`
        SELECT ${CONFLICT_COLS_MC}
        FROM memory_conflicts mc
        JOIN memories ma ON ma.id = mc.memory_a_id
        JOIN memories mb ON mb.id = mc.memory_b_id
        WHERE mc.id = ? AND ma.tenant_id = ? AND mb.tenant_id = ?
      `).get(conflictId, tenantId, tenantId)
    : db.prepare(`
        SELECT ${CONFLICT_COLS}
        FROM memory_conflicts WHERE id = ?
      `).get(conflictId)) as MemoryConflictRow | undefined;
}

function weakenConflictLoser(db: DatabaseSyncLike, t: ResolveTarget): LoserRemoval {
  // Halve the loser's half-life (weakens it over time)
  db.prepare(`UPDATE memories SET half_life_days = MAX(1, half_life_days / 2), updated_at = datetime('now') WHERE id = ?${t.scope.memScope}`)
    .run(t.loserId, ...t.scope.memArgs);
  return { loserRemoved: false, loserWasRaw: false, rejectedDigest: undefined, extraRemovedIds: [], extraRemovedRawIds: [] };
}

function removeConflictLoser(db: DatabaseSyncLike, t: ResolveTarget): LoserRemoval {
  // Removal is kind-aware: a bare DELETE on a raw loser fires the append-only trigger, so use the same helpers as the reject verb.
  // loserRemoved / loserWasRaw drive the conflicts_with_json skip below and the post-commit mirror purge.
  const removal: LoserRemoval = {
    loserRemoved: false,
    loserWasRaw: false,
    rejectedDigest: undefined,
    // Same-tenant duplicates of the loser's content that rejectLoserValue also removes; kept apart from loserId so audit and mirror purge cover all of them.
    extraRemovedIds: [],
    extraRemovedRawIds: [],
  };
  const { loserId, opts } = t;

  // SAFETY: loserRow's shape matches the four columns named in the
  // SELECT above.
  const loserRow = db
    .prepare(`SELECT kind, content, tenant_id, scope FROM memories WHERE id = ?${t.scope.memScope}`)
    .get(loserId, ...t.scope.memArgs) as { kind: string; content: string; tenant_id: string; scope: string | null } | undefined;

  if (loserRow) {
    const actor = opts?.rejectedBy ?? 'cli';
    const reason = opts?.reason ?? `resolveConflict ${t.conflictId}: kept ${t.keepId}`;

    if (opts?.rejectLoserValue) {
      removal.rejectedDigest = tombstoneLoserValue(db, t, loserRow, { actor, reason }, removal);
    }

    if (loserRow.kind === 'raw') {
      archiveRawMemory(db, loserId, { reason, who: actor });
      removal.loserWasRaw = true;
    } else {
      deleteEntryCore(db, loserId, { actor, suppressForgetAudit: true });
    }
    removal.loserRemoved = true;
  }
  // loserRow undefined = tenant-scope mismatch (or already gone); matches
  // the old tenant-scoped DELETE's silent 0-rows-affected behavior.
  return removal;
}

function recordRejectedLoserValue(
  db: DatabaseSyncLike,
  t: ResolveTarget,
  loserRow: { content: string; tenant_id: string },
  digest: string,
  who: { actor: string; reason: string },
): void {
  insertRejectedValue(db, {
    tenantId: loserRow.tenant_id ?? DEFAULT_TENANT_ID,
    digest,
    reason: who.reason,
    rejectedBy: who.actor,
    rejectedAt: new Date().toISOString(),
    sourceMemoryId: t.loserId,
    normalizedChars: normalizeValueForRejection(loserRow.content).length,
  });
}

/** Tombstones the loser's digest and removes its same-tenant duplicates into `removal`; returns the digest. */
function tombstoneLoserValue(
  db: DatabaseSyncLike,
  t: ResolveTarget,
  loserRow: { kind: string; content: string; tenant_id: string; scope: string | null },
  who: { actor: string; reason: string },
  removal: LoserRemoval,
): string {
  if (isPersonalScope(loserRow.scope)) {
    throw new BadRequestError(`cannot reject the value of personal memory ${t.loserId}: a rejection reaches the whole tenant, so its reason would show to everyone; resolve with forget instead`);
  }
  const { actor, reason } = who;
  const rejectedDigest = rejectionDigest(loserRow.content);
  recordRejectedLoserValue(db, t, loserRow, rejectedDigest, who);

  // Remove ALL live same-tenant rows whose digest matches (as reject-flow.ts rejectValue does), not just loserId; the O(N) scan is human-scale.
  // Tenant-scoped ONLY, since tombstones are; `keepId` is excluded even if its content matches, because the human chose to keep it.
  const loserTenantId = loserRow.tenant_id ?? DEFAULT_TENANT_ID;
  // SAFETY: dupRows' shape matches the four columns named in the SELECT above.
  const dupRows = db
    .prepare(`SELECT id, kind, content, scope FROM memories WHERE tenant_id = ? AND id != ? AND id != ?`)
    .all(loserTenantId, t.loserId, t.keepId) as Array<{ id: string; kind: string; content: string; scope: string | null }>;
  for (const dup of dupRows) {
    if (rejectionDigest(dup.content) !== rejectedDigest) continue;
    // Another person's personal row is outside this resolver's reach, as it is outside their recall.
    if (isPersonalScope(dup.scope) && dup.scope !== loserRow.scope) continue;
    if (dup.kind === 'raw') {
      archiveRawMemory(db, dup.id, { reason, who: actor });
      removal.extraRemovedRawIds.push(dup.id);
    } else {
      deleteEntryCore(db, dup.id, { actor, suppressForgetAudit: true });
    }
    removal.extraRemovedIds.push(dup.id);
  }
  return rejectedDigest;
}

function stripConflictRefs(db: DatabaseSyncLike, t: ResolveTarget, loserRemoved: boolean): void {
  const { memScope, memArgs } = t.scope;
  const { keepId, loserId } = t;
  // Clean up conflicts_with references.
  // SAFETY: keepRow's shape matches the single `conflicts_with_json` column selected above.
  const keepRow = db.prepare(`SELECT conflicts_with_json FROM memories WHERE id = ?${memScope}`).get(
    keepId,
    ...memArgs
  ) as { conflicts_with_json: string } | undefined;
  if (keepRow) {
    const refs: string[] = JSON.parse(keepRow.conflicts_with_json || '[]');
    const cleaned = refs.filter((r: string) => r !== loserId);
    db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?${memScope}`)
      .run(JSON.stringify(cleaned), keepId, ...memArgs);
  }

  if (!loserRemoved) {
    // SAFETY: loserRow's shape matches the single `conflicts_with_json`
    // column named in the SELECT below.
    const loserRow = db.prepare(`SELECT conflicts_with_json FROM memories WHERE id = ?${memScope}`).get(
      loserId,
      ...memArgs
    ) as { conflicts_with_json: string } | undefined;
    if (loserRow) {
      const refs: string[] = JSON.parse(loserRow.conflicts_with_json || '[]');
      const cleaned = refs.filter((r: string) => r !== keepId);
      db.prepare(`UPDATE memories SET conflicts_with_json = ?, updated_at = datetime('now') WHERE id = ?${memScope}`)
        .run(JSON.stringify(cleaned), loserId, ...memArgs);
    }
  }
}

function auditConflictResolve(
  db: DatabaseSyncLike,
  t: ResolveTarget,
  removal: LoserRemoval,
  tenantId: string | undefined,
): void {
  const { loserRemoved, loserWasRaw, rejectedDigest, extraRemovedIds } = removal;
  // Every path (weaken, forget, reject) lands exactly one conflict_resolve audit row.
  const conflictResolveMeta: ConflictResolveMeta = {
    conflictId: t.conflictId,
    keepId: t.keepId,
    loserId: t.loserId,
    disposition: loserRemoved ? (loserWasRaw ? 'archived_raw' : 'deleted') : 'weakened',
    rejected: Boolean(t.opts?.rejectLoserValue),
    // Every row this call removed, not just loserId, so the duplicate sweep (extraRemovedIds) is audited too.
    removedIds: loserRemoved ? [t.loserId, ...extraRemovedIds] : [],
  };
  // Assigned only when present so the serialized audit payload keeps
  // omitting the key, exactly as the pre-migration object literal did.
  if (rejectedDigest !== undefined) conflictResolveMeta.rejectedDigest = rejectedDigest;
  // Fresh spread literal: ConflictResolveMeta is a closed interface, not assignable to audit()'s Record<string, JsonValue> metadata otherwise.
  audit(db, 'conflict_resolve', { targetId: t.keepId, metadata: { ...conflictResolveMeta }, actor: t.opts?.rejectedBy ?? 'cli', tenantId });
}

function purgeRemovedLoserMirrors(
  hippoRoot: string,
  db: DatabaseSyncLike,
  loserId: string,
  removal: LoserRemoval,
): void {
  // Mirror purge and reaper stamp for EVERY removed loser (loserId and each extraRemovedIds duplicate), post-commit like the reject verb.
  // A non-raw mirror has no reaper, so skipping the purge would orphan it forever.
  for (const removedId of [loserId, ...removal.extraRemovedIds]) {
    const isRaw = removedId === loserId ? removal.loserWasRaw : removal.extraRemovedRawIds.includes(removedId);
    // purgeMirrorBestEffort retries once, then reports the explicit leftover paths for non-raw ids, which the cleanupArchivedMirrors reaper never scans.
    const mirrorOk = purgeMirrorBestEffort(hippoRoot, removedId, isRaw, 'resolveConflict');
    if (mirrorOk && isRaw) {
      db.prepare(`UPDATE raw_archive SET mirror_cleaned_at = ? WHERE memory_id = ?`).run(
        new Date().toISOString(),
        removedId,
      );
    }
  }
}

/** The conflict and loser ids every conflict_resolve audit row names. */
export function conflictResolveAuditsAt(db: DatabaseSyncLike): Array<{ conflictId: number; loserId: string }> {
  // SAFETY: SELECT of two fields every conflict_resolve audit row carries (ConflictResolveMeta above).
  return db.prepare(`SELECT json_extract(metadata_json, '$.conflictId') AS conflictId, json_extract(metadata_json, '$.loserId') AS loserId FROM audit_log WHERE op = 'conflict_resolve'`).all() as { conflictId: number; loserId: string }[];
}

/** Every resolved conflict with both sides. */
export function resolvedConflictsAt(db: DatabaseSyncLike): Array<{ id: number; memory_a_id: string; memory_b_id: string }> {
  // SAFETY: SELECT of three columns of resolved conflicts.
  return db.prepare(`SELECT id, memory_a_id, memory_b_id FROM memory_conflicts WHERE status = 'resolved'`).all() as {
    id: number;
    memory_a_id: string;
    memory_b_id: string;
  }[];
}
