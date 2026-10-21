// The in-memory Predictions group: forward claims and their closes, each save landing with its mirror memory.
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import type {
  Prediction,
  PredictionClose,
  PredictionListQuery,
  PredictionSave,
  Predictions,
} from '../port/predictions.js';
import type { PredictionBaserate } from '../port/types.js';
import { plural } from '../../base/util/format.js';
import { appendAudit, byBytes, nextId, peekId } from './rows.js';
import { put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

const newestFirst = (a: Prediction, b: Prediction): number => byBytes(b.createdAt, a.createdAt) || b.id - a.id;

function owned(t: MemoryTables, tenantId: string, id: number): Prediction | undefined {
  const row = t.predictions.get(id);
  return row?.tenantId === tenantId ? row : undefined;
}

function saveIn(t: MemoryTables, tenantId: string, input: PredictionSave, actor: string): Prediction {
  const { mirror } = input;
  const id = peekId(t, 'predictions');
  const row: Prediction = {
    id,
    memoryId: mirror.id,
    tenantId,
    classTag: input.classTag,
    claimText: input.claimText,
    estimateValue: input.estimateValue ?? null,
    estimateUnit: input.estimateUnit ?? null,
    targetDate: input.targetDate ?? null,
    actualValue: null,
    closureState: 'open',
    closedAt: null,
    closureNote: null,
    createdAt: new Date().toISOString(),
  };
  return stage(t, actor, (tx) => {
    const at = tx.audit.length;
    put(t, tx, mirror, actor);
    const metadata = {
      prediction_id: id,
      class_tag: input.classTag,
      has_estimate: input.estimateValue !== undefined,
      target_date: input.targetDate ?? null,
    };
    tx.audit.splice(at, 0, { tenantId, actor, op: 'predict_create', targetId: String(id), metadata });
    t.predictions.set(nextId(t, 'predictions'), row);
    return structuredClone(row);
  });
}

function closeIn(t: MemoryTables, tenantId: string, id: number, close: PredictionClose, actor: string): Prediction {
  const row = owned(t, tenantId, id);
  if (!row) throw new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
  if (row.closureState !== 'open') {
    throw new BadRequestError(
      `closePrediction: prediction ${id} is already closed (state='${row.closureState}'); ` +
        'cannot re-close. Open predictions only.',
    );
  }
  const closed: Prediction = {
    ...row,
    actualValue: close.actualValue ?? null,
    closureState: close.closureState,
    closedAt: new Date().toISOString(),
    closureNote: close.closureNote ?? null,
  };
  const metadata = {
    prediction_id: id,
    closure_state: close.closureState,
    has_actual: close.actualValue !== undefined,
  };
  appendAudit(t, [{ tenantId, actor, op: 'predict_close', targetId: String(id), metadata }]);
  t.predictions.set(id, closed);
  return structuredClone(closed);
}

function listIn(t: MemoryTables, tenantId: string, { classTag, closureState, limit, after }: PredictionListQuery) {
  const below = (row: Prediction): boolean => {
    if (!after) return true;
    const byKey = byBytes(row.createdAt, String(after.key));
    return byKey < 0 || (byKey === 0 && row.id < Number(after.id));
  };
  const hits = [...t.predictions.values()].filter(
    (row) =>
      row.tenantId === tenantId &&
      (classTag === undefined || row.classTag === classTag) &&
      (closureState === undefined || row.closureState === closureState) &&
      below(row),
  );
  return structuredClone(hits.sort(newestFirst).slice(0, limit));
}

type Closed = { estimate: number; actual: number };

const mean = (values: readonly number[]): number => values.reduce((s, x) => s + x, 0) / values.length;

function median(values: readonly number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** As hippo.db's predictionBaserateOf, which the adapter may not import; the predictions suite holds them alike. */
function baserateOf(classTag: string, rows: readonly Closed[]): PredictionBaserate {
  if (rows.length === 0) {
    const nulls = { meanEstimate: null, meanActual: null, meanRatio: null, p50Ratio: null, mae: null };
    return { classTag, nClosed: 0, nRatioEligible: 0, summary: '', ...nulls };
  }
  const ratios = rows.filter((r) => r.estimate > 0).map((r) => r.actual / r.estimate);
  const mae = mean(rows.map((r) => Math.abs(r.actual - r.estimate)));
  const meanRatio = ratios.length > 0 ? mean(ratios) : null;
  const ratioPart =
    meanRatio !== null ? `averaged ${meanRatio.toFixed(2)}x actual` : 'no ratio-eligible rows (all estimates were 0)';
  return {
    classTag,
    nClosed: rows.length,
    nRatioEligible: ratios.length,
    meanEstimate: mean(rows.map((r) => r.estimate)),
    meanActual: mean(rows.map((r) => r.actual)),
    meanRatio,
    p50Ratio: ratios.length > 0 ? median(ratios) : null,
    mae,
    summary: `Last ${plural(rows.length, 'estimate')} in class ${classTag} ${ratioPart} (MAE ${mae.toFixed(2)}).`,
  };
}

/** The class's stats over its closed rows in id order, since the float sums differ with row order. */
export function baserateIn(t: MemoryTables, tenantId: string, classTag: string): PredictionBaserate {
  const closed = [...t.predictions.values()]
    .sort((a, b) => a.id - b.id)
    .flatMap((row) =>
      row.tenantId === tenantId &&
      row.classTag === classTag &&
      row.closureState === 'closed' &&
      row.estimateValue !== null &&
      row.actualValue !== null
        ? [{ estimate: row.estimateValue, actual: row.actualValue }]
        : [],
    );
  return baserateOf(classTag, closed);
}

export function memoryPredictions(t: MemoryTables): Predictions {
  return {
    savePrediction: async (tenantId, input, actor) => saveIn(t, tenantId, input, actor),
    closePrediction: async (tenantId, id, close, actor) => closeIn(t, tenantId, id, close, actor),
    predictionById: async (tenantId, id) => structuredClone(owned(t, tenantId, id) ?? null),
    listPredictions: async (tenantId, query) => listIn(t, tenantId, query),
    async predictionBaserate(tenantId, classTag, actor) {
      const baserate = baserateIn(t, tenantId, classTag);
      const metadata = { class_tag: classTag, n_closed: baserate.nClosed };
      appendAudit(t, [{ tenantId, actor, op: 'predict_baserate', targetId: classTag, metadata }]);
      return baserate;
    },
  };
}
