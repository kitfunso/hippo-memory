// Status moves whose from-set sits in the UPDATE, so a row another writer already moved is left alone.
import type { DatabaseSyncLike, SqlResult } from '../../../db/index.js';
import { placeholders } from '../../../db/sql.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { SNAPSHOT_CLOSE_STATUSES } from '../../../base/ports/store/sessions.js';

// Table, key and column names reach the SQL only through this map, never from a caller.
const TRANSITIONS = {
  compactionDone: {
    table: 'compactions',
    key: 'id',
    tenant: true,
    from: ['summarised'],
    to: ['done'],
    set: ['items_written'],
  },
  goalComplete: {
    table: 'goal_stack',
    key: 'id',
    tenant: true,
    from: ['active', 'suspended'],
    to: ['completed'],
    set: ['completed_at', 'outcome_score'],
  },
  goalResume: {
    table: 'goal_stack',
    key: 'id',
    tenant: true,
    from: ['suspended'],
    to: ['active'],
    set: [],
  },
  conflictStale: {
    table: 'memory_conflicts',
    key: 'id',
    tenant: false,
    from: ['open'],
    to: ['resolved'],
    set: ['updated_at'],
  },
  quarantineApprove: {
    table: 'memory_quarantine',
    key: 'memory_id',
    tenant: true,
    from: ['pending'],
    to: ['approved'],
    set: ['decided_at', 'decided_by'],
  },
  quarantineReject: {
    table: 'memory_quarantine',
    key: 'memory_id',
    tenant: true,
    from: ['pending'],
    to: ['rejected'],
    set: ['decided_at', 'decided_by'],
  },
  snapshotClose: {
    table: 'task_snapshots',
    key: 'id',
    tenant: true,
    from: ['active'],
    to: SNAPSHOT_CLOSE_STATUSES,
    set: ['updated_at'],
  },
} as const;

type Transitions = typeof TRANSITIONS;
/** The name of one guarded status move. */
export type TransitionName = keyof Transitions;
type ToOf<N extends TransitionName> = Transitions[N]['to'][number];
type SetOf<N extends TransitionName> = Transitions[N]['set'][number];

type TenantPart<N extends TransitionName> = Transitions[N]['tenant'] extends true
  ? { readonly tenantId: string }
  : { readonly tenantId?: undefined };

type SetPart<N extends TransitionName> = [SetOf<N>] extends [never]
  ? { readonly set?: undefined }
  : { readonly set: { readonly [C in SetOf<N>]: SqlResult } };

type MoveParts<N extends TransitionName> = { readonly to: ToOf<N> } & TenantPart<N> & SetPart<N>;

/** The rows to move, the status to move them to, and the columns the move sets with it. */
export type StatusMove<N extends TransitionName> = MoveParts<N> & {
  readonly ids: readonly (string | number)[];
};

/** One row to move: `StatusMove` with a single `id`. */
export type OneStatusMove<N extends TransitionName> = MoveParts<N> & {
  readonly id: string | number;
};

interface Spec {
  readonly table: string;
  readonly key: string;
  readonly tenant: boolean;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly set: readonly string[];
}

interface LooseMove {
  readonly to: string;
  readonly ids: readonly (string | number)[];
  readonly tenantId?: string;
  readonly set?: Readonly<Record<string, SqlResult>>;
}

function updateSql(spec: Spec): string {
  const sets = ['status = ?', ...spec.set.map((column) => `${column} = ?`)].join(', ');
  const tenant = spec.tenant ? ' AND tenant_id = ?' : '';
  return (
    `UPDATE ${spec.table} SET ${sets} WHERE ${spec.key} IN (SELECT value FROM json_each(?))${tenant} ` +
    `AND status IN (${placeholders(spec.from.length)})`
  );
}

function applyMove(db: DatabaseSyncLike, name: TransitionName, move: LooseMove): number {
  const spec: Spec = TRANSITIONS[name];
  const { to, ids, tenantId, set = {} } = move;
  if (!spec.to.includes(to)) {
    throw new Error(`invalid ${spec.table} status "${to}": use ${spec.to.join(' | ')}`);
  }
  if (ids.length === 0) return 0;
  const params = [
    to,
    ...spec.set.map((column) => set[column]),
    JSON.stringify(ids),
    ...(spec.tenant ? [tenantId] : []),
    ...spec.from,
  ];
  const result = cachedStatement(db, updateSql(spec)).run(...params);
  return Number(result.changes ?? 0);
}

/** Moves the keyed rows that are in one of the transition's from-statuses to `to`, and returns how
 * many it moved: 0 when none was in a from-status. Throws when `to` is not one of its targets. */
export function moveStatus<N extends TransitionName>(
  db: DatabaseSyncLike,
  name: N,
  move: StatusMove<N>,
): number {
  return applyMove(db, name, move);
}

/** `moveStatus` for one row whose write scope already read its status: a row that left its
 * from-status since then throws, so the scope undoes its writes. */
export function moveOneStatus<N extends TransitionName>(
  db: DatabaseSyncLike,
  name: N,
  move: OneStatusMove<N>,
): void {
  const { id, to, tenantId, set } = move;
  if (applyMove(db, name, { ids: [id], to, tenantId, set }) === 1) return;
  const spec: Spec = TRANSITIONS[name];
  throw new Error(`${spec.table} row ${id} left ${spec.from.join(' | ')} before its status move`);
}
