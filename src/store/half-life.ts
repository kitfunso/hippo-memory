// A half-life move reads, writes, audits and records its base on one handle, so it commits whole or not at all.
import { getMeta, setMeta, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import { appendAuditEvent } from './sqlite/audit.js';
import { conflictResolveAuditsAt, resolvedConflictsAt } from './sqlite/conflicts.js';
import { iterateEveryTenantEntriesAt, objectMemoryRowsAt } from './sqlite/entry-reads.js';
import { setHalfLivesAt } from './sqlite/entry-writes.js';
import { HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY } from './sqlite/open.js';
import type { HalfLifeMove, HalfLifeRows } from './port/consolidation.js';

/** The base every store used before the base was recorded. */
const LEGACY_HALF_LIFE_BASE = 7;

function readBase(db: DatabaseSyncLike): number {
  const raw = Number(getMeta(db, HALF_LIFE_BASE_META_KEY, String(LEGACY_HALF_LIFE_BASE)));
  return Number.isFinite(raw) && raw > 0 ? raw : LEGACY_HALF_LIFE_BASE;
}

/** The base this store's memories are on: 7 days when none was ever recorded. */
export function recordedHalfLifeBaseAt(db: DatabaseSyncLike): number {
  return readBase(db);
}

function readRows(db: DatabaseSyncLike, from: number, typedPending: boolean): HalfLifeRows {
  return {
    from,
    typedPending,
    objectRows: typedPending ? objectMemoryRowsAt(db) : [],
    conflictAudits: typedPending ? conflictResolveAuditsAt(db) : [],
    resolvedConflicts: typedPending ? resolvedConflictsAt(db) : [],
    rows: iterateEveryTenantEntriesAt(db),
  };
}

/** Writes the move, then one audit event per tenant with each id's old half-life, so the move can be undone. */
function writeMove(db: DatabaseSyncLike, move: HalfLifeMove, actor: string): void {
  setHalfLivesAt(
    db,
    move.entries.map((e) => ({ id: e.id, halfLifeDays: e.halfLifeDays })),
  );
  const byTenant = new Map<string, Record<string, number>>();
  for (const e of move.entries) {
    // One record per tenant, filled in place: copying it per row made the write grow with the square of the store.
    let record = byTenant.get(e.tenantId);
    if (!record) byTenant.set(e.tenantId, (record = {}));
    record[e.id] = e.oldHalfLifeDays;
  }
  for (const [tenantId, oldHalfLives] of byTenant) {
    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'half_life_migrate',
      metadata: { from: move.from, to: move.to, ids: Object.keys(oldHalfLives), oldHalfLives },
    });
  }
}

/** Moves the store's half-lives to base `to` as `plan` decides from the rows read here, then
 * records the base. `outcome` is null when no move is due; a dry run plans and writes nothing. */
export function moveHalfLivesAt<R>(
  db: DatabaseSyncLike,
  to: number,
  opts: { dryRun: boolean; actor: string },
  plan: (rows: HalfLifeRows) => { moves: readonly HalfLifeMove[]; outcome: R },
): { from: number; outcome: R | null } {
  const run = () => {
    const from = readBase(db);
    const typedPending = getMeta(db, TYPED_HALF_LIFE_META_KEY, '') === '';
    if (!(Number.isFinite(to) && to > 0) || (from === to && !typedPending)) return { from, outcome: null };
    const rows = readRows(db, from, typedPending);
    const { moves, outcome } = plan(rows);
    if (opts.dryRun) return { from, outcome };

    for (const move of moves) writeMove(db, move, opts.actor);
    setMeta(db, HALF_LIFE_BASE_META_KEY, String(to));
    setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
    return { from, outcome };
  };
  // Plan, write, audit and record the base under one write lock, so a concurrent write or sleep cannot interleave.
  return opts.dryRun ? run() : withWriteScope(db, 'migrate_half_life', run);
}
