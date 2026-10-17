import {
  predictionMirror,
  type Prediction,
  type PredictionBaserate,
  type SavePredictionOptions,
} from '../../store/predictions.js';
import { configOf } from '../config-of.js';
import type { PredictionClose, PredictionSave, Predictions } from '../../store/port.js';
import type { StoreContext } from '../types.js';

const predictionsOf = (ctx: StoreContext): Predictions => ctx.store.predictions;

export async function savePrediction(ctx: StoreContext, input: PredictionSave): Promise<Prediction> {
  return predictionsOf(ctx).savePrediction(ctx.tenantId, input, ctx.actor.subject);
}

/** A claim saved with its recall mirror, built under the store root's half-life as the HTTP create route builds it. */
export async function recordPrediction(
  ctx: StoreContext,
  claim: SavePredictionOptions,
): Promise<Prediction> {
  return savePrediction(ctx, {
    ...claim,
    mirror: predictionMirror(ctx.tenantId, claim, configOf(ctx).defaultHalfLifeDays),
  });
}

export async function listPredictions(
  ctx: StoreContext,
  query: Parameters<Predictions['listPredictions']>[1],
): Promise<Prediction[]> {
  return predictionsOf(ctx).listPredictions(ctx.tenantId, query);
}

export async function predictionBaserate(
  ctx: StoreContext,
  classTag: string,
): Promise<PredictionBaserate> {
  return predictionsOf(ctx).predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: StoreContext, id: number): Promise<Prediction | null> {
  return predictionsOf(ctx).predictionById(ctx.tenantId, id);
}

export async function closePrediction(
  ctx: StoreContext,
  id: number,
  close: PredictionClose,
): Promise<Prediction> {
  return predictionsOf(ctx).closePrediction(ctx.tenantId, id, close, ctx.actor.subject);
}
