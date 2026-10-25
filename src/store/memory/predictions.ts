// The in-memory prediction rows: forward claims and their closes, each save landing with its mirror memory.
import type {
  Prediction,
  PredictionClose,
  PredictionListQuery,
  PredictionSave,
} from '../../base/ports/store/objects.js';
import type { PredictionBaserate } from '../../base/ports/store/types.js';
import { isBelow, newestFirst } from '../rules/order.js';
import {
  closeMissError,
  predictionBaserateOf,
  predictionCloseMetadata,
  predictionCreateMetadata,
} from '../rules/predictions.js';
import { appendAudit, nextId, ownedRow, peekId } from './rows.js';
import { put, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

const predictionWalk = { key: (p: Prediction) => p.createdAt, intId: (p: Prediction) => p.id };
const newestPrediction = newestFirst<Prediction>(predictionWalk);

export function savePredictionIn(t: MemoryTables, tenantId: string, input: PredictionSave): Prediction {
  const { mirror, actor } = input;
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

export function closePredictionIn(t: MemoryTables, tenantId: string, id: number, close: PredictionClose): Prediction {
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
  appendAudit(t, [{ tenantId, actor: close.actor, op: 'predict_close', targetId: String(id), metadata }]);
  t.predictions.set(id, closed);
  return structuredClone(closed);
}

export function listPredictionsIn(
  t: MemoryTables,
  tenantId: string,
  { classTag, closureState, limit, after }: PredictionListQuery,
): Prediction[] {
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

/** The baserate with its predict_baserate row, which an empty class gets too. */
export function predictionBaserateIn(
  t: MemoryTables,
  tenantId: string,
  classTag: string,
  actor: string,
): PredictionBaserate {
  const baserate = baserateIn(t, tenantId, classTag);
  const metadata = { class_tag: classTag, n_closed: baserate.nClosed };
  appendAudit(t, [{ tenantId, actor, op: 'predict_baserate', targetId: classTag, metadata }]);
  return baserate;
}
