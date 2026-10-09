// A half-life move reads, writes, audits and records its base on one handle, so it commits whole or not at all.
import { closeHippoDb, getMeta, openHippoDb, setMeta, withWriteScope, type DatabaseSyncLike } from '../db/index.js';
import type { MemoryEntry } from '../core/memory.js';
import { appendAuditEvent } from './audit.js';
import { conflictResolveAuditsAt, resolvedConflictsAt } from './conflicts.js';
import { objectMemoryRowsAt, selectAllEntries } from './entry-reads.js';
import { setHalfLivesAt } from './entry-writes.js';
import { HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY, openStore } from './open.js';

/** The base every store used before the base was recorded. */
const LEGACY_HALF_LIFE_BASE = 7;

/** What a move is planned from. The object and conflict rows are read only while the typed move is pending. */
export interface HalfLifeRows {
  /** The base the store's memories are on. */
  from: number;
  /** True until the store has moved its object memories off their old flat half-life. */
  typedPending: boolean;
  all: MemoryEntry[];
  objectRows: ReturnType<typeof objectMemoryRowsAt>;
  conflictAudits: ReturnType<typeof conflictResolveAuditsAt>;
  resolvedConflicts: ReturnType<typeof resolvedConflictsAt>;
}

/** Copies carrying their new half-life, and the bases their audit rows name. */
export interface HalfLifeMove {
  from: number;
  to: number;
  entries: readonly MemoryEntry[];
}

function readBase(db: DatabaseSyncLike): number {
  const raw = Number(getMeta(db, HALF_LIFE_BASE_META_KEY, String(LEGACY_HALF_LIFE_BASE)));
  return Number.isFinite(raw) && raw > 0 ? raw : LEGACY_HALF_LIFE_BASE;
}

/** The base this store's memories are on: 7 days when none was ever recorded. */
export function recordedHalfLifeBase(hippoRoot: string): number {
  const db = openHippoDb(hippoRoot);
  try {
    return readBase(db);
  } finally {
    closeHippoDb(db);
  }
}

function readRows(db: DatabaseSyncLike, from: number, typedPending: boolean): HalfLifeRows {
  const all = selectAllEntries(db);
  return {
    from,
    typedPending,
    all,
    objectRows: typedPending ? objectMemoryRowsAt(db) : [],
    conflictAudits: typedPending ? conflictResolveAuditsAt(db) : [],
    resolvedConflicts: typedPending ? resolvedConflictsAt(db) : [],
  };
}

/** Writes the move, then one audit event per tenant with each id's old half-life, so the move can be undone. */
function writeMove(db: DatabaseSyncLike, move: HalfLifeMove, old: ReadonlyMap<string, number>, actor: string): void {
  setHalfLivesAt(db, move.entries.map((e) => ({ id: e.id, halfLifeDays: e.half_life_days })));
  const byTenant = new Map<string, Record<string, number>>();
  for (const e of move.entries) {
    // One record per tenant, filled in place: copying it per row made the write grow with the square of the store.
    let record = byTenant.get(e.tenantId);
    if (!record) byTenant.set(e.tenantId, (record = {}));
    record[e.id] = old.get(e.id)!;
  }
  for (const [tenantId, oldHalfLives] of byTenant) {
    appendAuditEvent(db, {
      tenantId,
      actor,
      op: 'half_life_migrate',
      metadata: { from: move.from, to: move.to, ids: Object.keys(oldHalfLives), oldHalfLives }
    });
  }
}

/** Moves the store's half-lives to base `to` as `plan` decides from the rows read here, then records the base. `outcome` is null when no move is due; a dry run plans and writes nothing. */
export function moveHalfLives<R>(
  hippoRoot: string,
  to: number,
  opts: { dryRun: boolean; actor: string },
  plan: (rows: HalfLifeRows) => { moves: readonly HalfLifeMove[]; outcome: R },
): { from: number; outcome: R | null } {
  const db = openStore(hippoRoot);
  try {
    const run = () => {
      const from = readBase(db);
      const typedPending = getMeta(db, TYPED_HALF_LIFE_META_KEY, '') === '';
      if (!(Number.isFinite(to) && to > 0) || (from === to && !typedPending)) return { from, outcome: null };
      const rows = readRows(db, from, typedPending);
      const { moves, outcome } = plan(rows);
      if (opts.dryRun) return { from, outcome };

      const old = new Map(rows.all.map((e) => [e.id, e.half_life_days]));
      for (const move of moves) writeMove(db, move, old, opts.actor);
      setMeta(db, HALF_LIFE_BASE_META_KEY, String(to));
      setMeta(db, TYPED_HALF_LIFE_META_KEY, '1');
      return { from, outcome };
    };
    // Plan, write, audit and record the base under one write lock, so a concurrent write or sleep cannot interleave.
    return opts.dryRun ? run() : withWriteScope(db, 'migrate_half_life', run);
  } finally {
    closeHippoDb(db);
  }
}
