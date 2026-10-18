import { predictionMirror } from '../../core/prediction.js';
import type { PredictionClose, PredictionSave, Predictions } from '../../store/port.js';
import type { Context } from '../types.js';
import type { Prediction, SavePredictionOptions } from '../../store/port/predictions.js';
import type { PredictionBaserate } from '../../store/port/types.js';

const predictionsOf = (ctx: Context): Predictions => ctx.store.predictions;

export async function predictionSave(ctx: Context, input: PredictionSave): Promise<Prediction> {
  return predictionsOf(ctx).savePrediction(ctx.tenantId, input, ctx.actor.subject);
}

/** A claim saved with its recall mirror, built under the store root's half-life as the HTTP create route builds it. */
export async function predictionRecord(ctx: Context, claim: SavePredictionOptions): Promise<Prediction> {
  return predictionSave(ctx, {
    ...claim,
    mirror: predictionMirror(ctx.tenantId, claim, ctx.config.defaultHalfLifeDays),
  });
}

export async function predictionList(
  ctx: Context,
  query: Parameters<Predictions['listPredictions']>[1],
): Promise<Prediction[]> {
  return predictionsOf(ctx).listPredictions(ctx.tenantId, query);
}

export async function predictionBaserate(ctx: Context, classTag: string): Promise<PredictionBaserate> {
  return predictionsOf(ctx).predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: Context, id: number): Promise<Prediction | null> {
  return predictionsOf(ctx).predictionById(ctx.tenantId, id);
}

export async function predictionClose(ctx: Context, id: number, close: PredictionClose): Promise<Prediction> {
  return predictionsOf(ctx).closePrediction(ctx.tenantId, id, close, ctx.actor.subject);
}
