// What both adapters say when a prediction is saved, closed or summed, once: audit metadata, refusal texts, baserate.
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import type { JsonObject } from '../../base/util/json.js';
import { plural } from '../../base/util/format.js';
import type { PredictionBaserate } from '../../base/ports/store/types.js';

const present = (value: number | null | undefined): boolean => value !== undefined && value !== null;

/** The predict_create row's metadata: ids and flags, never the claim text. */
export const predictionCreateMetadata = (
  predictionId: number,
  input: {
    readonly classTag: string;
    readonly estimateValue?: number | null;
    readonly targetDate?: string | null;
  },
): JsonObject => ({
  prediction_id: predictionId,
  class_tag: input.classTag,
  has_estimate: present(input.estimateValue),
  target_date: input.targetDate ?? null,
});

/** The predict_close row's metadata; a null actual counts as none, as the stored column does. */
export const predictionCloseMetadata = (
  predictionId: number,
  close: {
    readonly closureState: string;
    readonly actualValue?: number | null;
  },
): JsonObject => ({
  prediction_id: predictionId,
  closure_state: close.closureState,
  has_actual: present(close.actualValue),
});

/** The refusal for a close that matched no open row: `closureState` is the row's state, or null when none exists. */
export function closeMissError(tenantId: string, id: number, closureState: string | null): Error {
  if (closureState === null) {
    return new NotFoundError(`closePrediction: prediction ${id} not found for tenant ${tenantId}`);
  }
  return new BadRequestError(
    `closePrediction: prediction ${id} is already closed (state='${closureState}'); ` +
      'cannot re-close. Open predictions only.',
  );
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
