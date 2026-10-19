// Each savable kind answers alike on hippo.db and on a store held in memory: rows, order, refusals and audit rows.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B } from '../_helpers/store-conformance.js';
import {
  T1,
  T2,
  T3,
  T4,
  T5,
  odd,
  CASES,
  type Call,
  conforms,
  type DraftOptions,
  saving,
  save,
  close,
  retire,
  byId,
  list,
  ids,
  mirrorsOf,
  rowOf,
  mirrorView,
  added,
  auditRow,
  createOp,
  supersedeOp,
  closeOp,
  created,
  remembered,
  superseded,
  useObjectsConformance,
} from '../_helpers/objects-conformance.js';

useObjectsConformance();

describe.each(CASES)('Objects, the $kind kind', (c) => {
  it('lists nothing, then the one row a save made, and reads it only inside its tenant; the create row sits ahead of the remember row', async () => {
    const first = saving(c, 1, { changeSummary: 'a first version keeps none' });
    const side = await conforms([
      list(c.kind, { limit: 10 }),
      byId(c.kind, 1),
      save(c, first),
      list(c.kind, { limit: 10 }),
      byId(c.kind, 1),
      byId(c.kind, 1, TENANT_B),
      byId(c.kind, 2),
      list(c.kind, { limit: 10 }, TENANT_B),
      mirrorsOf([first], TENANT_A),
      mirrorsOf([first], TENANT_B),
    ]);
    const row = rowOf(c, 1, first);
    expect(side.outcomes).toEqual([
      { value: [] },
      { value: null },
      { value: row },
      { value: [row] },
      { value: row },
      { value: null },
      { value: null },
      { value: [] },
      { value: [mirrorView(c, first)] },
      { value: [] },
    ]);
    expect(added(side)).toEqual([created(c, 0, 1, first), remembered(1, first)]);
  });

  it('a successor takes the next version, links the row it replaces and marks it superseded, the supersede row ahead of the create row', async () => {
    const first = saving(c, 1);
    const second = saving(c, 2, { at: T2, supersedesId: 1, changeSummary: 'tightened' });
    const third = saving(c, 3, { at: T3, supersedesId: 2 });
    const side = await conforms([
      save(c, first),
      save(c, second),
      save(c, third),
      byId(c.kind, 1),
      byId(c.kind, 2),
      byId(c.kind, 3),
      mirrorsOf([first, second, third]),
    ]);
    const tightened = c.versioned ? 'tightened' : undefined;
    const rows = [
      rowOf(c, 1, first, { status: 'superseded', supersededBy: 2, supersededAt: T2 }),
      rowOf(c, 2, second, {
        version: 2,
        changeSummary: tightened,
        status: 'superseded',
        supersededBy: 3,
        supersededAt: T3,
      }),
      rowOf(c, 3, third, { version: 3 }),
    ];
    expect(side.outcomes).toEqual([
      { value: rowOf(c, 1, first) },
      { value: rowOf(c, 2, second, { version: 2, changeSummary: tightened }) },
      { value: rows[2] },
      { value: rows[0] },
      { value: rows[1] },
      { value: rows[2] },
      { value: [mirrorView(c, first), mirrorView(c, second), mirrorView(c, third)] },
    ]);
    expect(added(side)).toEqual([
      created(c, 0, 1, first),
      remembered(1, first),
      superseded(c, 2, 1, 2, second, 2),
      created(c, 3, 2, second, 2),
      remembered(4, second),
      superseded(c, 5, 2, 3, third, 3),
      created(c, 6, 3, third, 3),
      remembered(7, third),
    ]);
  });

  it('a save that replaces a missing, a foreign, a superseded or a closed row is refused and keeps no mirror, no row, no audit row and no id', async () => {
    const first = saving(c, 1);
    const second = saving(c, 2, { at: T2, supersedesId: 1 });
    const third = saving(c, 3, { at: T2 });
    const refused = [
      saving(c, 4, { at: T4, supersedesId: 9 }),
      saving(c, 5, { at: T4, supersedesId: 2, tenantId: TENANT_B }),
      saving(c, 6, { at: T4, supersedesId: 1 }),
      saving(c, 7, { at: T4, supersedesId: 3 }),
    ];
    const next = saving(c, 8, { at: T5 });
    const side = await conforms([
      save(c, first),
      save(c, second),
      save(c, third),
      retire(c, 3, T3),
      ...refused.map((d) => save(c, d)),
      mirrorsOf(refused),
      ids(c.kind, { limit: 10 }),
      ids(c.kind, { limit: 10 }, TENANT_B),
      byId(c.kind, 2),
      save(c, next),
    ]);
    expect(side.outcomes.slice(4)).toEqual([
      { value: { refused: 'missing' } },
      { value: { refused: 'missing' } },
      { value: { refused: 'status', status: 'superseded' } },
      { value: { refused: 'status', status: 'closed' } },
      { value: [] },
      { value: [3, 2, 1] },
      { value: [] },
      { value: rowOf(c, 2, second, { version: 2 }) },
      { value: rowOf(c, 4, next) },
    ]);
    expect(added(side).map((e) => e.op)).toEqual([
      createOp(c.kind),
      'remember',
      supersedeOp(c.kind),
      createOp(c.kind),
      'remember',
      createOp(c.kind),
      'remember',
      closeOp(c.kind),
      createOp(c.kind),
      'remember',
    ]);
  });

  it('close retires an active row once with one close row; a superseded, a closed, a missing and a foreign row are refused and stay as they were', async () => {
    const first = saving(c, 1);
    const second = saving(c, 2, { at: T2, supersedesId: 1 });
    const third = saving(c, 3, { at: T2 });
    const side = await conforms([
      save(c, first),
      save(c, second),
      save(c, third),
      retire(c, 2, T3),
      retire(c, 2, T4),
      retire(c, 1, T4),
      retire(c, 9, T4),
      retire(c, 3, T4, TENANT_B),
      close(c.kind, 3, T4, []),
      byId(c.kind, 1),
      byId(c.kind, 2),
      byId(c.kind, 3),
    ]);
    const closed = rowOf(c, 2, second, { version: 2, status: 'closed', closedAt: T3 });
    expect(side.outcomes.slice(3)).toEqual([
      { value: closed },
      { value: { refused: 'status', status: 'closed' } },
      { value: { refused: 'status', status: 'superseded' } },
      { value: { refused: 'missing' } },
      { value: { refused: 'missing' } },
      { value: { refused: 'status', status: 'active' } },
      { value: rowOf(c, 1, first, { status: 'superseded', supersededBy: 2, supersededAt: T2 }) },
      { value: closed },
      { value: rowOf(c, 3, third) },
    ]);
    expect(added(side).slice(7)).toEqual([auditRow(7, T3, closeOp(c.kind), '2', { [c.idKey]: 2 })]);
  });

  /** Ids 1 to 8, id 5 in the other tenant: three instants each shared by two of the tenant's rows, then 1 closed and 2 superseded by 8. Odd ids hold the alpha filter value. */
  const seed = (): Call[] => {
    const row = (n: number, at: string, opts: DraftOptions = {}): Call =>
      save(c, saving(c, n, { at, group: odd(n) ? 'alpha' : 'beta', ...opts }));
    return [
      row(1, T1),
      row(2, T1),
      row(3, T2),
      row(4, T2),
      row(5, T2, { tenantId: TENANT_B }),
      row(6, T3),
      row(7, T3),
      retire(c, 1, T4),
      row(8, T4, { supersedesId: 2 }),
    ];
  };
  const SEEDED = 9;

  it('lists newest first with the larger id first on a shared instant, under, at and over the cap, by each status and by the filter column', async () => {
    const side = await conforms([
      ...seed(),
      ids(c.kind, { limit: 10 }),
      ids(c.kind, { limit: 7 }),
      ids(c.kind, { limit: 3 }),
      ids(c.kind, { limit: 1 }),
      ids(c.kind, { status: 'active', limit: 10 }),
      ids(c.kind, { status: 'superseded', limit: 10 }),
      ids(c.kind, { status: 'closed', limit: 10 }),
      ids(c.kind, { limit: 10 }, TENANT_B),
      ids(c.kind, { status: 'closed', limit: 10 }, TENANT_B),
      ids(c.kind, { filter: 'alpha', limit: 10 }),
      ids(c.kind, { filter: 'beta', limit: 10 }),
      ids(c.kind, { filter: 'alpha', status: 'active', limit: 10 }),
      ids(c.kind, { filter: 'gamma', limit: 10 }),
      ids(c.kind, { filter: 'alpha', limit: 10 }, TENANT_B),
    ]);
    const every = [8, 7, 6, 4, 3, 2, 1];
    const active = [8, 7, 6, 4, 3];
    // A kind with no filter column ignores the filter.
    const filtered = c.filtered ? [[7, 3, 1], [8, 6, 4, 2], [7, 3], [], [5]] : [every, every, active, every, [5]];
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: every },
      { value: every },
      { value: [8, 7, 6] },
      { value: [8] },
      { value: active },
      { value: [2] },
      { value: [1] },
      { value: [5] },
      { value: [] },
      ...filtered.map((value) => ({ value })),
    ]);
  });

  it('pages across a boundary that splits two rows sharing an instant, without a skip or a repeat', async () => {
    const side = await conforms([
      ...seed(),
      ids(c.kind, { limit: 2 }),
      ids(c.kind, { limit: 2, after: { key: T3, id: 7 } }),
      ids(c.kind, { limit: 2, after: { key: T2, id: 4 } }),
      ids(c.kind, { limit: 2, after: { key: T1, id: 2 } }),
      ids(c.kind, { limit: 2, after: { key: T1, id: 1 } }),
      ids(c.kind, { status: 'active', limit: 2, after: { key: T3, id: 7 } }),
      ids(c.kind, { status: 'active', limit: 2, after: { key: T2, id: 4 } }),
      ids(c.kind, { filter: 'alpha', limit: 1, after: { key: T3, id: 7 } }),
      ids(c.kind, { limit: 10, after: { key: '2026-03-01T12:00:02.500Z', id: 0 } }),
      ids(c.kind, { limit: 10, after: { key: T3, id: 7 } }, TENANT_B),
    ]);
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: [8, 7] },
      { value: [6, 4] },
      { value: [3, 2] },
      { value: [1] },
      { value: [] },
      { value: [6, 4] },
      { value: [3] },
      { value: c.filtered ? [3] : [6] },
      { value: [4, 3, 2, 1] },
      { value: [5] },
    ]);
  });
});
