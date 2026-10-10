import type { Prediction, PredictionBaserate } from '../store/predictions.js';
import { requireGroup, storeFor } from '../store/index.js';
import type { PredictionClose, PredictionSave, Predictions } from '../store/port.js';
import type { Context } from './types.js';

const predictionsOf = (ctx: Context): Predictions => requireGroup(storeFor(ctx), 'predictions');

export async function savePrediction(ctx: Context, input: PredictionSave): Promise<Prediction> {
  return predictionsOf(ctx).savePrediction(ctx.tenantId, input, ctx.actor.subject);
}

export async function listPredictions(ctx: Context, query: Parameters<Predictions['listPredictions']>[1]): Promise<Prediction[]> {
  return predictionsOf(ctx).listPredictions(ctx.tenantId, query);
}

export async function predictionBaserate(ctx: Context, classTag: string): Promise<PredictionBaserate> {
  return predictionsOf(ctx).predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: Context, id: number): Promise<Prediction | null> {
  return predictionsOf(ctx).predictionById(ctx.tenantId, id);
}

export async function closePrediction(ctx: Context, id: number, close: PredictionClose): Promise<Prediction> {
  return predictionsOf(ctx).closePrediction(ctx.tenantId, id, close, ctx.actor.subject);
}
