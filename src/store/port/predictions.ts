import type { MemoryEntry } from '../../core/memory.js';
import type { ClosureState } from '../../core/prediction.js';
import type { KeysetPosition } from '../../util/keyset.js';
import type { PredictionBaserate } from './types.js';

/** A claim to save and the memory row that mirrors it into recall: core builds it with
 * `predictionMirror` in the tenant the save names, so every store keeps the same row. */
export interface PredictionSave extends SavePredictionOptions {
  readonly mirror: MemoryEntry;
}

export interface PredictionClose {
  readonly closureState: Exclude<ClosureState, 'open'>;
  readonly actualValue?: number;
  readonly closureNote?: string;
}

/** Which of a tenant's predictions a list reads: every class when `classTag` is unset (it is
 * never empty), every state when `closureState` is, and a closed state only inside a class. */
export type PredictionFilter =
  | { readonly classTag?: string; readonly closureState?: 'open' }
  | { readonly classTag: string; readonly closureState: ClosureState };

export type PredictionListQuery = PredictionFilter & { readonly limit: number; readonly after?: KeysetPosition };

/** The reads and writes behind the predictions routes. createdAt and closedAt are the store's
 * own clock at the write, as `toISOString` gives it, since the list orders createdAt as text. */
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
  /** Nullable: a memory may be deleted (forget /
   *  consolidate / archive) without breaking the prediction row. */
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
