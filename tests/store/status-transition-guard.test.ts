// The status guard sits in the UPDATE: a row outside a transition's from-set is left alone, and a one-row move on it throws.
import { beforeEach, describe, expect, it } from 'vitest';
import { makeRoot } from '../_helpers/make-root.js';
import { onHandle } from '../_helpers/test-session.js';
import { withWriteScopeOr, type DatabaseSyncLike, type SqlValue } from '../../src/db/index.js';
import {
  moveOneStatus,
  moveStatus,
  type OneStatusMove,
  type StatusMove,
  type TransitionName,
} from '../../src/store/sqlite/runtime/status-transitions.js';

type Id = string | number;
type Ids = readonly Id[];

const TENANT = 'default';
const OTHER_TENANT = 'other';
const STAMP = '2026-01-01T00:00:00.000Z';

interface Spec {
  readonly table: string;
  readonly key: 'id' | 'memory_id';
  readonly from: readonly string[];
  readonly to: readonly string[];
  /** Statuses the table holds that a move from `from` must leave alone. */
  readonly illegal: readonly string[];
  /** The columns a move sets besides status, as the row holds them afterwards. */
  readonly moved: Readonly<Record<string, string | number>>;
  readonly tenanted: boolean;
  readonly idOf: (n: number) => Id;
  /** One row with only the NOT NULL columns the table asks for. */
  readonly seed: (db: DatabaseSyncLike, row: { id: Id; status: string; tenant: string }) => void;
}

const SPECS = {
  compactionDone: {
    table: 'compactions',
    key: 'id',
    from: ['summarised'],
    to: ['done'],
    illegal: ['started', 'done', 'no-summary'],
    moved: { items_written: 3 },
    tenanted: true,
    idOf: (n) => `cmp-${n}`,
    seed: (db, { id, status, tenant }) => {
      db.prepare(
        `INSERT INTO compactions (tenant_id, id, session_id, started_at, status) VALUES (?, ?, 's1', ?, ?)`,
      ).run(tenant, id, STAMP, status);
    },
  },
  goalComplete: {
    table: 'goal_stack',
    key: 'id',
    from: ['active', 'suspended'],
    to: ['completed'],
    illegal: ['completed'],
    moved: { completed_at: STAMP, outcome_score: 0.8 },
    tenanted: true,
    idOf: (n) => `goal-${n}`,
    seed: (db, row) => seedGoal(db, row),
  },
  goalResume: {
    table: 'goal_stack',
    key: 'id',
    from: ['suspended'],
    to: ['active'],
    illegal: ['active', 'completed'],
    moved: {},
    tenanted: true,
    idOf: (n) => `goal-${n}`,
    seed: (db, row) => seedGoal(db, row),
  },
  conflictStale: {
    table: 'memory_conflicts',
    key: 'id',
    from: ['open'],
    to: ['resolved'],
    illegal: ['resolved'],
    moved: { updated_at: STAMP },
    tenanted: false,
    idOf: (n) => n,
    seed: (db, { id, status }) => {
      db.prepare(
        `INSERT INTO memory_conflicts (id, memory_a_id, memory_b_id, reason, status, detected_at, updated_at)
         VALUES (?, ?, ?, 'clash', ?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      ).run(id, `a-${id}`, `b-${id}`, status);
    },
  },
  quarantineApprove: {
    table: 'memory_quarantine',
    key: 'memory_id',
    from: ['pending'],
    to: ['approved'],
    illegal: ['approved', 'rejected'],
    moved: { decided_at: STAMP, decided_by: 'admin' },
    tenanted: true,
    idOf: (n) => `mem-${n}`,
    seed: (db, row) => seedQuarantine(db, row),
  },
  quarantineReject: {
    table: 'memory_quarantine',
    key: 'memory_id',
    from: ['pending'],
    to: ['rejected'],
    illegal: ['approved', 'rejected'],
    moved: { decided_at: STAMP, decided_by: 'admin' },
    tenanted: true,
    idOf: (n) => `mem-${n}`,
    seed: (db, row) => seedQuarantine(db, row),
  },
  snapshotClose: {
    table: 'task_snapshots',
    key: 'id',
    from: ['active'],
    to: ['cleared', 'done', 'session-ended'],
    illegal: ['superseded', 'cleared', 'done', 'session-ended'],
    moved: { updated_at: STAMP },
    tenanted: true,
    idOf: (n) => n,
    seed: (db, { id, status, tenant }) => {
      db.prepare(
        `INSERT INTO task_snapshots (id, tenant_id, task, summary, next_step, status, source, created_at, updated_at)
         VALUES (?, ?, 't', 's', 'n', ?, 'test', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      ).run(id, tenant, status);
    },
  },
} satisfies Record<TransitionName, Spec>;

function seedGoal(db: DatabaseSyncLike, { id, status, tenant }: { id: Id; status: string; tenant: string }): void {
  db.prepare(
    `INSERT INTO goal_stack (id, tenant_id, session_id, goal_name, status, created_at) VALUES (?, ?, 's1', 'goal', ?, ?)`,
  ).run(id, tenant, status, STAMP);
}

function seedQuarantine(
  db: DatabaseSyncLike,
  { id, status, tenant }: { id: Id; status: string; tenant: string },
): void {
  db.prepare(
    `INSERT INTO memory_quarantine (tenant_id, memory_id, reason, status, quarantined_at) VALUES (?, ?, 'poisoned', ?, ?)`,
  ).run(tenant, id, status, STAMP);
}

// A store-kit caller passes a plain string, so `to` is typed loosely here and the runtime check owns it.
type Moves = {
  [N in TransitionName]: {
    readonly many: (ids: Ids, to: string) => StatusMove<N>;
    readonly one: (id: Id) => OneStatusMove<N>;
  };
};

// SAFETY: each `to as ...` is the one wrong target a store-kit caller can pass as a plain string.
const MOVES: Moves = {
  compactionDone: {
    many: (ids, to) => ({ tenantId: TENANT, ids, to: to as 'done', set: { items_written: 3 } }),
    one: (id) => ({ tenantId: TENANT, id, to: 'done', set: { items_written: 3 } }),
  },
  goalComplete: {
    many: (ids, to) => ({
      tenantId: TENANT,
      ids,
      to: to as 'completed',
      set: { completed_at: STAMP, outcome_score: 0.8 },
    }),
    one: (id) => ({ tenantId: TENANT, id, to: 'completed', set: { completed_at: STAMP, outcome_score: 0.8 } }),
  },
  goalResume: {
    many: (ids, to) => ({ tenantId: TENANT, ids, to: to as 'active' }),
    one: (id) => ({ tenantId: TENANT, id, to: 'active' }),
  },
  conflictStale: {
    many: (ids, to) => ({ ids, to: to as 'resolved', set: { updated_at: STAMP } }),
    one: (id) => ({ id, to: 'resolved', set: { updated_at: STAMP } }),
  },
  quarantineApprove: {
    many: (ids, to) => ({
      tenantId: TENANT,
      ids,
      to: to as 'approved',
      set: { decided_at: STAMP, decided_by: 'admin' },
    }),
    one: (id) => ({ tenantId: TENANT, id, to: 'approved', set: { decided_at: STAMP, decided_by: 'admin' } }),
  },
  quarantineReject: {
    many: (ids, to) => ({
      tenantId: TENANT,
      ids,
      to: to as 'rejected',
      set: { decided_at: STAMP, decided_by: 'admin' },
    }),
    one: (id) => ({ tenantId: TENANT, id, to: 'rejected', set: { decided_at: STAMP, decided_by: 'admin' } }),
  },
  snapshotClose: {
    many: (ids, to) => ({ tenantId: TENANT, ids, to: to as 'cleared', set: { updated_at: STAMP } }),
    one: (id) => ({ tenantId: TENANT, id, to: 'cleared', set: { updated_at: STAMP } }),
  },
};

// SAFETY: SPECS satisfies Record<TransitionName, Spec>, so its keys are exactly the transition names.
const NAMES = Object.keys(SPECS) as TransitionName[];
const pairs = (pick: (spec: Spec) => readonly string[]): (readonly [TransitionName, string])[] =>
  NAMES.flatMap((name) => pick(SPECS[name]).map((status) => [name, status] as const));
const ILLEGAL = pairs((spec) => spec.illegal);
const LEGAL = pairs((spec) => spec.from);
const TENANTED = NAMES.filter((name) => SPECS[name].tenanted);

function many<N extends TransitionName>(db: DatabaseSyncLike, name: N, ids: Ids, to = SPECS[name].to[0]): number {
  return moveStatus(db, name, MOVES[name].many(ids, to));
}

function one<N extends TransitionName>(db: DatabaseSyncLike, name: N, id: Id): void {
  moveOneStatus(db, name, MOVES[name].one(id));
}

function rowOf(db: DatabaseSyncLike, name: TransitionName, id: Id): Record<string, SqlValue> | undefined {
  const { table, key } = SPECS[name];
  return db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(id);
}

describe('status transitions', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('status-guard');
  });

  const seeded = (db: DatabaseSyncLike, name: TransitionName, status: string, tenant = TENANT): Id => {
    const id = SPECS[name].idOf(1);
    SPECS[name].seed(db, { id, status, tenant });
    return id;
  };

  it.each(ILLEGAL)('%s: moveStatus leaves a %s row alone and reports 0', (name, status) => {
    onHandle(root, (db) => {
      const id = seeded(db, name, status);
      const before = rowOf(db, name, id);
      expect(many(db, name, [id])).toBe(0);
      expect(rowOf(db, name, id)).toEqual(before);
    });
  });

  it.each(ILLEGAL)('%s: moveOneStatus on a %s row throws and leaves it alone', (name, status) => {
    onHandle(root, (db) => {
      const id = seeded(db, name, status);
      const before = rowOf(db, name, id);
      const { table, from } = SPECS[name];
      expect(() => one(db, name, id)).toThrow(`${table} row ${id} left ${from.join(' | ')} before its status move`);
      expect(rowOf(db, name, id)).toEqual(before);
    });
  });

  it.each(LEGAL)('%s: moves a %s row, reports 1 and sets its columns', (name, status) => {
    onHandle(root, (db) => {
      const id = seeded(db, name, status);
      expect(many(db, name, [id])).toBe(1);
      expect(rowOf(db, name, id)).toMatchObject({ status: SPECS[name].to[0], ...SPECS[name].moved });
    });
  });

  it.each(NAMES)('%s: moveOneStatus moves a row in a from-status', (name) => {
    onHandle(root, (db) => {
      const id = seeded(db, name, SPECS[name].from[0]);
      one(db, name, id);
      expect(rowOf(db, name, id)).toMatchObject({ status: SPECS[name].to[0], ...SPECS[name].moved });
    });
  });

  it.each(TENANTED)("%s: leaves another tenant's row alone", (name) => {
    onHandle(root, (db) => {
      const id = seeded(db, name, SPECS[name].from[0], OTHER_TENANT);
      const before = rowOf(db, name, id);
      expect(many(db, name, [id])).toBe(0);
      expect(rowOf(db, name, id)).toEqual(before);
    });
  });

  it.each(NAMES)('%s: a target outside the transition throws and moves nothing', (name) => {
    onHandle(root, (db) => {
      const id = seeded(db, name, SPECS[name].from[0]);
      const before = rowOf(db, name, id);
      const { table, to } = SPECS[name];
      expect(() => many(db, name, [id], 'bogus')).toThrow(`invalid ${table} status "bogus": use ${to.join(' | ')}`);
      expect(rowOf(db, name, id)).toEqual(before);
    });
  });

  it.each(NAMES)('%s: no ids reports 0', (name) => {
    onHandle(root, (db) => {
      expect(many(db, name, [])).toBe(0);
    });
  });

  it('a list of ids moves only the rows in a from-status', () => {
    onHandle(root, (db) => {
      const [open, resolved, openToo] = [1, 2, 3];
      for (const [id, status] of [
        [open, 'open'],
        [resolved, 'resolved'],
        [openToo, 'open'],
      ] as const) {
        SPECS.conflictStale.seed(db, { id, status, tenant: TENANT });
      }
      const before = rowOf(db, 'conflictStale', resolved);
      expect(many(db, 'conflictStale', [open, resolved, openToo])).toBe(2);
      expect(rowOf(db, 'conflictStale', resolved)).toEqual(before);
    });
  });

  it('a refused one-row move undoes the earlier writes of its scope', () => {
    onHandle(root, (db) => {
      const id = seeded(db, 'compactionDone', 'started');
      const earlier = SPECS.compactionDone.idOf(2);
      expect(() =>
        withWriteScopeOr(db, 'guard_test', () => {
          SPECS.compactionDone.seed(db, { id: earlier, status: 'started', tenant: TENANT });
          one(db, 'compactionDone', id);
          return null;
        }),
      ).toThrow('left summarised before its status move');
      expect(rowOf(db, 'compactionDone', earlier)).toBeUndefined();
      expect(rowOf(db, 'compactionDone', id)).toMatchObject({ status: 'started' });
    });
  });
});
