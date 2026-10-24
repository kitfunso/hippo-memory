// The in-memory Predictions group: forward claims and their closes, each save landing with its mirror memory.
import {
  predictionBaserateOf,
  type Prediction,
  type PredictionClose,
  type PredictionListQuery,
  type PredictionSave,
  type Predictions,
} from '../port/objects.js';
import type { PredictionBaserate } from '../port/types.js';
import { isBelow, newestFirst } from '../rules/order.js';
import { closeMissError, predictionCloseMetadata, predictionCreateMetadata } from '../rules/predictions.js';
import { appendAudit, nextId, ownedRow, peekId } from './rows.js';
import { put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

const predictionWalk = { key: (p: Prediction) => p.createdAt, intId: (p: Prediction) => p.id };
const newestPrediction = newestFirst<Prediction>(predictionWalk);

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
    const metadata = predictionCreateMetadata(id, input);
    tx.audit.splice(at, 0, { tenantId, actor, op: 'predict_create', targetId: String(id), metadata });
    t.predictions.set(nextId(t, 'predictions'), row);
    return structuredClone(row);
  });
}

function closeIn(t: MemoryTables, tenantId: string, id: number, close: PredictionClose, actor: string): Prediction {
  const row = ownedRow(t.predictions, tenantId, id);
  if (!row || row.closureState !== 'open') throw closeMissError(tenantId, id, row?.closureState ?? null);
  const closed: Prediction = {
    ...row,
    actualValue: close.actualValue ?? null,
    closureState: close.closureState,
    closedAt: new Date().toISOString(),
    closureNote: close.closureNote ?? null,
  };
  const metadata = predictionCloseMetadata(id, close);
  appendAudit(t, [{ tenantId, actor, op: 'predict_close', targetId: String(id), metadata }]);
  t.predictions.set(id, closed);
  return structuredClone(closed);
}

function listIn(t: MemoryTables, tenantId: string, { classTag, closureState, limit, after }: PredictionListQuery) {
  const hits = [...t.predictions.values()].filter(
    (row) =>
      row.tenantId === tenantId &&
      (classTag === undefined || row.classTag === classTag) &&
      (closureState === undefined || row.closureState === closureState) &&
      (!after || isBelow(predictionWalk, row, after)),
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
    predictionById: async (tenantId, id) => structuredClone(ownedRow(t.predictions, tenantId, id) ?? null),
    listPredictions: async (tenantId, query) => listIn(t, tenantId, query),
    async predictionBaserate(tenantId, classTag, actor) {
      const baserate = baserateIn(t, tenantId, classTag);
      const metadata = { class_tag: classTag, n_closed: baserate.nClosed };
      appendAudit(t, [{ tenantId, actor, op: 'predict_baserate', targetId: classTag, metadata }]);
      return baserate;
    },
  };
}
