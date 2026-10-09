// Predictions answers alike on hippo.db and on a store held in memory: the same rows, the same order, the same errors and the same audit rows.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import type { AuditEvent } from '../src/audit.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { auditHighIdAt } from '../src/store/key-audit.js';
import type { PredictionClose, PredictionListQuery, PredictionSave } from '../src/store/port.js';
import { predictionMirror, type Prediction, type PredictionBaserate, type SavePredictionOpts } from '../src/store/predictions.js';
import { inMemoryPredictionsStore } from './_helpers/in-memory-predictions-store.js';
import { onBothStores, seedTwoTenants, TENANT_A, TENANT_B, type GroupCall, type SideResult, type TwoTenantFixture } from './_helpers/store-conformance.js';

const NOW = '2026-03-01T12:00:00.000Z';
const T1 = '2026-03-01T12:00:01.000Z';
const T2 = '2026-03-01T12:00:02.000Z';
const T3 = '2026-03-01T12:00:03.000Z';
const T4 = '2026-03-01T12:00:04.000Z';
const ACTOR = 'api_key:caller';

/** The mirror as a caller can tell it apart: its row, tenant and what recall matches on. */
interface MirrorView {
  readonly id: string;
  readonly tenantId: string;
  readonly content: string;
  readonly tags: readonly string[];
}

type Value = Prediction | Prediction[] | number[] | PredictionBaserate | MirrorView[] | null;
type Call = GroupCall<'predictions', Value>;
type Side = SideResult<Value>;

let fixture: TwoTenantFixture;
let baseline: Side;
let nextAuditId: number;

async function conforms(calls: readonly Call[]): Promise<Side> {
  const sides = await onBothStores(fixture, 'predictions', inMemoryPredictionsStore, calls);
  expect(sides.other).toEqual(sides.sqlite);
  return sides.sqlite;
}

/** Built once per call list, so both stores are handed the same mirror id. */
function claim(classTag: string, fields: Partial<SavePredictionOpts> = {}, tenantId = TENANT_A): PredictionSave {
  const opts: SavePredictionOpts = { classTag, claimText: `the ${classTag} work lands on time`, ...fields };
  return { ...opts, mirror: predictionMirror(tenantId, opts, 30) };
}

/** Sets the clock inside the call, so each store reads the same time at the same step. */
const at = (iso: string, call: Call): Call => (g, store) => {
  vi.setSystemTime(new Date(iso));
  return call(g, store);
};
const save = (input: PredictionSave): Call => (g) => g.savePrediction(input.mirror.tenantId, input, ACTOR);
const close = (id: number, how: PredictionClose, tenantId = TENANT_A): Call => (g) => g.closePrediction(tenantId, id, how, ACTOR);
const byId = (id: number, tenantId = TENANT_A): Call => (g) => g.predictionById(tenantId, id);
const list = (query: PredictionListQuery, tenantId = TENANT_A): Call => (g) => g.listPredictions(tenantId, query);
const ids = (query: PredictionListQuery, tenantId = TENANT_A): Call => async (g) => (await g.listPredictions(tenantId, query)).map((p) => p.id);
const baserate = (classTag: string, tenantId = TENANT_A): Call => (g) => g.predictionBaserate(tenantId, classTag, ACTOR);
const mirrorOf = (input: PredictionSave, tenantId = TENANT_A): Call => async (_g, store) =>
  (await store.entriesByIds([input.mirror.id], tenantId)).map((e) => ({ id: e.id, tenantId: e.tenantId, content: e.content, tags: e.tags }));

function openRow(id: number, input: PredictionSave, createdAt: string): Prediction {
  return {
    id, memoryId: input.mirror.id, tenantId: input.mirror.tenantId, classTag: input.classTag, claimText: input.claimText,
    estimateValue: input.estimateValue ?? null, estimateUnit: input.estimateUnit ?? null, targetDate: input.targetDate ?? null,
    actualValue: null, closureState: 'open', closedAt: null, closureNote: null, createdAt,
  };
}

/** The rows a run added, each under the next audit id in turn. */
function added(side: Side): AuditEvent[] {
  return side.audit.slice(baseline.audit.length);
}

function auditRow(nth: number, ts: string, op: AuditEvent['op'], targetId: string, metadata: AuditEvent['metadata'], tenantId = TENANT_A): AuditEvent {
  return { id: nextAuditId + nth, ts, tenantId, actor: ACTOR, op, targetId, metadata };
}

const REMEMBERED = { kind: 'distilled', scope: null };

beforeAll(async () => {
  fixture = seedTwoTenants();
  const db = openHippoDb(fixture.dir);
  try {
    nextAuditId = auditHighIdAt(db) + 1;
  } finally {
    closeHippoDb(db);
  }
  baseline = await conforms([]);
});

afterAll(() => {
  rmSync(fixture.dir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Predictions.savePrediction and predictionById', () => {
  it('saves the open row and its mirror in the tenant named, the predict_create row ahead of the remember row', async () => {
    const full = claim('sprint', { estimateValue: 3, estimateUnit: 'days', targetDate: '2026-04-01' });
    const bare = claim('launch');
    const side = await conforms([
      at(T1, save(full)), at(T2, save(bare)), byId(1), byId(2), list({ limit: 10 }), mirrorOf(full),
      byId(1, TENANT_B), byId(3), list({ limit: 10 }, TENANT_B), mirrorOf(full, TENANT_B),
    ]);
    const first: Prediction = {
      id: 1, memoryId: full.mirror.id, tenantId: TENANT_A, classTag: 'sprint', claimText: full.claimText, estimateValue: 3, estimateUnit: 'days',
      targetDate: '2026-04-01', actualValue: null, closureState: 'open', closedAt: null, closureNote: null, createdAt: T1,
    };
    const second = openRow(2, bare, T2);
    expect(side.outcomes).toEqual([
      { value: first }, { value: second }, { value: first }, { value: second }, { value: [second, first] },
      { value: [{ id: full.mirror.id, tenantId: TENANT_A, content: full.claimText, tags: ['prediction', 'sprint'] }] },
      { value: null }, { value: null }, { value: [] }, { value: [] },
    ]);
    expect(added(side)).toEqual([
      auditRow(0, T1, 'predict_create', '1', { prediction_id: 1, class_tag: 'sprint', has_estimate: true, target_date: '2026-04-01' }),
      auditRow(1, T1, 'remember', full.mirror.id, REMEMBERED),
      auditRow(2, T2, 'predict_create', '2', { prediction_id: 2, class_tag: 'launch', has_estimate: false, target_date: null }),
      auditRow(3, T2, 'remember', bare.mirror.id, REMEMBERED),
    ]);
  });

  it('a mirror id another tenant holds rejects and keeps no row, no audit row and no id', async () => {
    const mine = claim('sprint');
    const theirs = claim('sprint', {}, TENANT_B);
    const clash: PredictionSave = { ...theirs, mirror: { ...theirs.mirror, id: mine.mirror.id } };
    const side = await conforms([at(T1, save(mine)), save(clash), list({ limit: 10 }, TENANT_B), mirrorOf(mine), save(theirs)]);
    expect(side.outcomes).toEqual([
      { value: openRow(1, mine, T1) },
      { error: `ConflictError: Memory ${mine.mirror.id} belongs to another tenant` },
      { value: [] },
      { value: [{ id: mine.mirror.id, tenantId: TENANT_A, content: mine.claimText, tags: ['prediction', 'sprint'] }] },
      { value: openRow(2, theirs, T1) },
    ]);
    expect(added(side).map((e) => [e.op, e.tenantId])).toEqual([
      ['predict_create', TENANT_A], ['remember', TENANT_A], ['predict_create', TENANT_B], ['remember', TENANT_B],
    ]);
  });
});

describe('Predictions.listPredictions', () => {
  /** Ids 1 to 8, id 5 in the other tenant: three timestamps each shared by rows of one tenant, then 1 and 2 closed and 8 closed-unknown. */
  const seed = (): Call[] => [
    at(T1, save(claim('sprint'))), save(claim('sprint')),
    at(T2, save(claim('launch'))), save(claim('sprint')), save(claim('sprint', {}, TENANT_B)),
    at(T3, save(claim('sprint'))), save(claim('sprint')), save(claim('sprint')),
    at(T4, close(1, { closureState: 'closed', actualValue: 2 })), close(2, { closureState: 'closed' }), close(8, { closureState: 'closed-unknown' }),
  ];
  const SEEDED = 11;
  const SEED_AUDIT_ROWS = 8 * 2 + 3;

  it('reads every state, the open rows and one closed state newest first, the larger id first on a shared timestamp', async () => {
    const side = await conforms([
      ...seed(),
      ids({ limit: 10 }), ids({ classTag: 'sprint', limit: 10 }),
      ids({ closureState: 'open', limit: 10 }), ids({ classTag: 'sprint', closureState: 'open', limit: 10 }),
      ids({ classTag: 'sprint', closureState: 'closed', limit: 10 }), ids({ classTag: 'sprint', closureState: 'closed-unknown', limit: 10 }),
      ids({ classTag: 'launch', closureState: 'closed', limit: 10 }), ids({ limit: 10 }, TENANT_B), ids({ classTag: 'launch', limit: 10 }, TENANT_B),
    ]);
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: [8, 7, 6, 4, 3, 2, 1] }, { value: [8, 7, 6, 4, 2, 1] },
      { value: [7, 6, 4, 3] }, { value: [7, 6, 4] },
      { value: [2, 1] }, { value: [8] },
      { value: [] }, { value: [5] }, { value: [] },
    ]);
    expect(added(side)).toHaveLength(SEED_AUDIT_ROWS);
  });

  it('pages each mode across a boundary that splits two rows sharing a timestamp, without a skip or a repeat', async () => {
    const side = await conforms([
      ...seed(),
      ids({ limit: 2 }), ids({ limit: 2, after: { key: T3, id: 7 } }), ids({ limit: 2, after: { key: T2, id: 4 } }), ids({ limit: 2, after: { key: T1, id: 2 } }),
      ids({ closureState: 'open', limit: 1 }), ids({ closureState: 'open', limit: 5, after: { key: T3, id: 7 } }),
      ids({ classTag: 'sprint', closureState: 'open', limit: 5, after: { key: T2, id: 4 } }),
      ids({ classTag: 'sprint', closureState: 'closed', limit: 1 }), ids({ classTag: 'sprint', closureState: 'closed', limit: 1, after: { key: T1, id: 2 } }),
      ids({ limit: 10, after: { key: '2026-03-01T12:00:02.500Z', id: 0 } }), ids({ limit: 10, after: { key: T3, id: 7 } }, TENANT_B),
    ]);
    expect(side.outcomes.slice(SEEDED)).toEqual([
      { value: [8, 7] }, { value: [6, 4] }, { value: [3, 2] }, { value: [1] },
      { value: [7] }, { value: [6, 4, 3] },
      { value: [] },
      { value: [2] }, { value: [1] },
      { value: [4, 3, 2, 1] }, { value: [5] },
    ]);
  });
});

describe('Predictions.closePrediction', () => {
  it('closes with an actual and a note, and as closed-unknown with neither, one predict_close row each', async () => {
    const first = claim('sprint', { estimateValue: 3 });
    const second = claim('sprint');
    const side = await conforms([
      at(T1, save(first)), save(second),
      at(T2, close(1, { closureState: 'closed', actualValue: 5, closureNote: 'two days late' })), at(T3, close(2, { closureState: 'closed-unknown' })),
      byId(1), byId(2),
    ]);
    const closed: Prediction = { ...openRow(1, first, T1), actualValue: 5, closureState: 'closed', closedAt: T2, closureNote: 'two days late' };
    const unknown: Prediction = { ...openRow(2, second, T1), closureState: 'closed-unknown', closedAt: T3 };
    expect(side.outcomes.slice(2)).toEqual([{ value: closed }, { value: unknown }, { value: closed }, { value: unknown }]);
    expect(added(side).slice(4)).toEqual([
      auditRow(4, T2, 'predict_close', '1', { prediction_id: 1, closure_state: 'closed', has_actual: true }),
      auditRow(5, T3, 'predict_close', '2', { prediction_id: 2, closure_state: 'closed-unknown', has_actual: false }),
    ]);
  });

  it('a second close rejects and the first close stands', async () => {
    const input = claim('sprint', { estimateValue: 3 });
    const side = await conforms([
      at(T1, save(input)), at(T2, close(1, { closureState: 'closed', actualValue: 5 })),
      at(T3, close(1, { closureState: 'closed-unknown', closureNote: 'retry' })), byId(1),
    ]);
    const closed: Prediction = { ...openRow(1, input, T1), actualValue: 5, closureState: 'closed', closedAt: T2 };
    expect(side.outcomes.slice(1)).toEqual([
      { value: closed },
      { error: "BadRequestError: closePrediction: prediction 1 is already closed (state='closed'); cannot re-close. Open predictions only." },
      { value: closed },
    ]);
    expect(added(side).map((e) => e.op)).toEqual(['predict_create', 'remember', 'predict_close']);
  });

  it('a missing id and another tenant\'s id reject as not found, and the row stays open with no audit row', async () => {
    const input = claim('sprint');
    const side = await conforms([
      at(T1, save(input)), at(T2, close(9, { closureState: 'closed', actualValue: 5 })),
      close(1, { closureState: 'closed', actualValue: 5 }, TENANT_B), byId(1),
    ]);
    expect(side.outcomes.slice(1)).toEqual([
      { error: `NotFoundError: closePrediction: prediction 9 not found for tenant ${TENANT_A}` },
      { error: `NotFoundError: closePrediction: prediction 1 not found for tenant ${TENANT_B}` },
      { value: openRow(1, input, T1) },
    ]);
    expect(added(side).map((e) => e.op)).toEqual(['predict_create', 'remember']);
  });
});

describe('Predictions.predictionBaserate', () => {
  it('a class with no closed row answers the empty baserate and still writes its audit row', async () => {
    const side = await conforms([at(T1, save(claim('sprint', { estimateValue: 3 }))), at(T2, baserate('sprint')), baserate('launch', TENANT_B)]);
    const empty = { nClosed: 0, nRatioEligible: 0, meanEstimate: null, meanActual: null, meanRatio: null, p50Ratio: null, mae: null, summary: '' };
    expect(side.outcomes.slice(1)).toEqual([{ value: { classTag: 'sprint', ...empty } }, { value: { classTag: 'launch', ...empty } }]);
    expect(added(side).slice(2)).toEqual([
      auditRow(2, T2, 'predict_baserate', 'sprint', { class_tag: 'sprint', n_closed: 0 }),
      auditRow(3, T2, 'predict_baserate', 'launch', { class_tag: 'launch', n_closed: 0 }, TENANT_B),
    ]);
  });

  it('counts only the tenant\'s closed rows of the class that hold both values, and sums them in id order', async () => {
    const closedAs = (actualValue: number): PredictionClose => ({ closureState: 'closed', actualValue });
    const side = await conforms([
      at(T1, save(claim('sprint', { estimateValue: 0.1 }))), save(claim('sprint', { estimateValue: 0.2 })), save(claim('sprint', { estimateValue: 0.3 })),
      save(claim('sprint', { estimateValue: 0 })), save(claim('sprint', { estimateValue: 9 })), save(claim('sprint', { estimateValue: 9 })),
      save(claim('sprint', { estimateValue: 9 })), save(claim('sprint')), save(claim('launch', { estimateValue: 9 })),
      save(claim('sprint', { estimateValue: 3 }, TENANT_B)),
      // Closed newest first, so a store that sums in closing order answers a meanEstimate of 0.15.
      at(T2, close(3, closedAs(0.6))), close(2, closedAs(0.4)), close(1, closedAs(0.2)), close(4, closedAs(1)),
      close(6, { closureState: 'closed-unknown', actualValue: 9 }), close(7, { closureState: 'closed' }), close(8, closedAs(9)), close(9, closedAs(9)),
      close(10, closedAs(9), TENANT_B),
      at(T3, baserate('sprint')), baserate('launch'), baserate('sprint', TENANT_B),
    ]);
    expect(side.outcomes.slice(19)).toEqual([
      {
        value: {
          classTag: 'sprint', nClosed: 4, nRatioEligible: 3, meanEstimate: 0.15000000000000002, meanActual: 0.55, meanRatio: 2, p50Ratio: 2, mae: 0.4,
          summary: 'Last 4 estimates in class sprint averaged 2.00x actual (MAE 0.40).',
        },
      },
      {
        value: {
          classTag: 'launch', nClosed: 1, nRatioEligible: 1, meanEstimate: 9, meanActual: 9, meanRatio: 1, p50Ratio: 1, mae: 0,
          summary: 'Last 1 estimate in class launch averaged 1.00x actual (MAE 0.00).',
        },
      },
      {
        value: {
          classTag: 'sprint', nClosed: 1, nRatioEligible: 1, meanEstimate: 3, meanActual: 9, meanRatio: 3, p50Ratio: 3, mae: 6,
          summary: 'Last 1 estimate in class sprint averaged 3.00x actual (MAE 6.00).',
        },
      },
    ]);
    expect(added(side).slice(-3)).toEqual([
      auditRow(29, T3, 'predict_baserate', 'sprint', { class_tag: 'sprint', n_closed: 4 }),
      auditRow(30, T3, 'predict_baserate', 'launch', { class_tag: 'launch', n_closed: 1 }),
      auditRow(31, T3, 'predict_baserate', 'sprint', { class_tag: 'sprint', n_closed: 1 }, TENANT_B),
    ]);
  });
});
