import {
  predictionMirror,
  type Prediction,
  type PredictionBaserate,
  type SavePredictionOpts,
} from '../../store/predictions.js';
import { configOf } from '../config-of.js';
import type { PredictionClose, PredictionSave, Predictions } from '../../store/port.js';
import type { ContextWith } from '../types.js';

const predictionsOf = (ctx: ContextWith<'predictions'>): Predictions => ctx.store.predictions;

export async function savePrediction(ctx: ContextWith<'predictions'>, input: PredictionSave): Promise<Prediction> {
  return predictionsOf(ctx).savePrediction(ctx.tenantId, input, ctx.actor.subject);
}

/** A claim saved with its recall mirror, built under the store root's half-life as the HTTP create route builds it. */
export async function recordPrediction(
  ctx: ContextWith<'predictions'>,
  claim: SavePredictionOpts,
): Promise<Prediction> {
  return savePrediction(ctx, {
    ...claim,
    mirror: predictionMirror(ctx.tenantId, claim, configOf(ctx).defaultHalfLifeDays),
  });
}

export async function listPredictions(
  ctx: ContextWith<'predictions'>,
  query: Parameters<Predictions['listPredictions']>[1],
): Promise<Prediction[]> {
  return predictionsOf(ctx).listPredictions(ctx.tenantId, query);
}

export async function predictionBaserate(
  ctx: ContextWith<'predictions'>,
  classTag: string,
): Promise<PredictionBaserate> {
  return predictionsOf(ctx).predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: ContextWith<'predictions'>, id: number): Promise<Prediction | null> {
  return predictionsOf(ctx).predictionById(ctx.tenantId, id);
}

export async function closePrediction(
  ctx: ContextWith<'predictions'>,
  id: number,
  close: PredictionClose,
): Promise<Prediction> {
  return predictionsOf(ctx).closePrediction(ctx.tenantId, id, close, ctx.actor.subject);
}
