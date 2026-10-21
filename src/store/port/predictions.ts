import type { MemoryEntry } from '../../base/memory/memory.js';
import type { ClosureState } from '../../base/records/prediction.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { plural } from '../../base/util/format.js';
import type { PredictionBaserate } from './types.js';

/** A claim to save and the memory row that mirrors it into recall: core builds it with `predictionMirror` in the tenant
 * the save names, so every store keeps the same row. */
export interface PredictionSave extends SavePredictionOptions {
  readonly mirror: MemoryEntry;
}

export interface PredictionClose {
  readonly closureState: Exclude<ClosureState, 'open'>;
  readonly actualValue?: number;
  readonly closureNote?: string;
}

/** Which of a tenant's predictions a list reads: every class when `classTag` is unset (it is never empty), every state
 * when `closureState` is, and a closed state only inside a class. */
export type PredictionFilter =
  | { readonly classTag?: string; readonly closureState?: 'open' }
  | { readonly classTag: string; readonly closureState: ClosureState };

export type PredictionListQuery = PredictionFilter & { readonly limit: number; readonly after?: KeysetPosition };

/** The reads and writes behind the predictions routes. createdAt and closedAt are the store's own clock at the write,
 * as `toISOString` gives it, since the list orders createdAt as text. */
export interface Predictions {
  /** In one transaction: writes `mirror` as `EntryWrites.writeEntry` does, inserts the open row under the next id, and
   * appends one predict_create row ({prediction_id, class_tag, has_estimate, target_date}) ahead of the mirror's
   * remember row. Resolves to the row saved. */
  savePrediction(tenantId: string, input: PredictionSave, actor: string): Promise<Prediction>;
  /** Closes the tenant's open row and appends one predict_close row ({prediction_id, closure_state, has_actual}) in one
   * transaction; the mirror stays as saved. A missing or other-tenant id rejects with NotFoundError, an already-closed
   * row with BadRequestError; neither writes anything. */
  closePrediction(tenantId: string, id: number, close: PredictionClose, actor: string): Promise<Prediction>;
  /** The tenant's row; null for a missing id or another tenant's. No audit row. */
  predictionById(tenantId: string, id: number): Promise<Prediction | null>;
  /** At most `limit` rows, newest first: by createdAt compared as text in byte order, then by id, both descending, so
   * the order is total. `after` keeps only the rows below its (createdAt, id) pair in that order. No audit row. */
  listPredictions(tenantId: string, query: PredictionListQuery): Promise<Prediction[]>;
  /** `predictionBaserateOf` over the tenant's closed (not closed-unknown) rows of the class with an estimate and an
   * actual, in ascending id order (its float sums depend on it). Then appends one predict_baserate row ({class_tag,
   * n_closed}), also for a class with no such row. */
  predictionBaserate(tenantId: string, classTag: string, actor: string): Promise<PredictionBaserate>;
}

export interface Prediction {
  id: number;
  /** Nullable: a memory may be deleted (forget / consolidate / archive) without breaking the prediction row. */
  memoryId: string | null;
  tenantId: string;
  classTag: string;
  claimText: string;
  estimateValue: number | null;
  estimateUnit: string | null;
  targetDate: string | null;
  actualValue: number | null;
  closureState: ClosureState;
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
}

export interface SavePredictionOptions {
  classTag: string;
  claimText: string;
  estimateValue?: number;
  estimateUnit?: string;
  targetDate?: string;
}

/** One closed prediction as the baserate reads it: both values set. */
interface ClosedEstimate {
  readonly estimate: number;
  readonly actual: number;
}

function emptyBaserate(classTag: string): PredictionBaserate {
  const nulls = { meanEstimate: null, meanActual: null, meanRatio: null, p50Ratio: null, mae: null };
  return { classTag, nClosed: 0, nRatioEligible: 0, summary: '', ...nulls };
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** A class's stats over its closed rows, summed in the order given. Every store computes them here, so no two can
 * disagree on the arithmetic. */
export function predictionBaserateOf(classTag: string, rows: readonly ClosedEstimate[]): PredictionBaserate {
  const nClosed = rows.length;
  if (nClosed === 0) return emptyBaserate(classTag);
  const ratios = rows.filter((r) => r.estimate > 0).map((r) => r.actual / r.estimate);
  const nRatioEligible = ratios.length;
  const mae = rows.reduce((s, r) => s + Math.abs(r.actual - r.estimate), 0) / nClosed;
  const meanRatio = nRatioEligible > 0 ? ratios.reduce((s, x) => s + x, 0) / nRatioEligible : null;
  const ratioPart =
    meanRatio !== null ? `averaged ${meanRatio.toFixed(2)}x actual` : 'no ratio-eligible rows (all estimates were 0)';
  return {
    classTag,
    nClosed,
    nRatioEligible,
    meanEstimate: rows.reduce((s, r) => s + r.estimate, 0) / nClosed,
    meanActual: rows.reduce((s, r) => s + r.actual, 0) / nClosed,
    meanRatio,
    p50Ratio: nRatioEligible > 0 ? median(ratios.slice().sort((a, b) => a - b)) : null,
    mae,
    summary: `Last ${plural(nClosed, 'estimate')} in class ${classTag} ${ratioPart} (MAE ${mae.toFixed(2)}).`,
  };
}
