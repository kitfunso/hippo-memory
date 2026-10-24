// What both adapters say when a prediction is saved or closed, once: the audit metadata and the refusal texts.
import { BadRequestError, NotFoundError } from '../../base/errors/api-errors.js';
import type { JsonObject } from '../../base/util/json.js';

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
