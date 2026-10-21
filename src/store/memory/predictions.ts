// The in-memory Predictions group: forward claims and their closes, each save landing with its mirror memory.
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import {
  predictionBaserateOf,
  type Prediction,
  type PredictionClose,
  type PredictionListQuery,
  type PredictionSave,
  type Predictions,
} from '../port/predictions.js';
import type { PredictionBaserate } from '../port/types.js';
import { byBytes, newestFirst } from '../rules/order.js';
import { appendAudit, nextId, peekId } from './rows.js';
import { put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

const newestPrediction = newestFirst<Prediction>({ key: (p) => p.createdAt, intId: (p) => p.id });

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
  return structuredClone(hits.sort(newestPrediction).slice(0, limit));
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
  return predictionBaserateOf(classTag, closed);
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
