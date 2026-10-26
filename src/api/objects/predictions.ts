import { predictionMirror } from '../../base/records/prediction.js';
import type { PredictionClose, PredictionListQuery, PredictionSave } from '../../base/ports/store.js';
import type { ContextWith } from '../types.js';
import type { Prediction, SavePredictionOptions } from '../../base/ports/store/objects.js';
import type { PredictionBaserate } from '../../base/ports/store/types.js';

export async function predictionSave(
  ctx: ContextWith<'objects'>,
  input: Omit<PredictionSave, 'actor'>,
): Promise<Prediction> {
  return ctx.store.objects.saveObject(ctx.tenantId, 'prediction', { ...input, actor: ctx.actor.subject });
}

/** A claim saved with its recall mirror, built under the store root's half-life as the HTTP create route builds it. */
export async function predictionRecord(ctx: ContextWith<'objects'>, claim: SavePredictionOptions): Promise<Prediction> {
  return predictionSave(ctx, {
    ...claim,
    mirror: predictionMirror(ctx.tenantId, claim, ctx.config.defaultHalfLifeDays, ctx.infra.clock()),
  });
}

export async function predictionList(ctx: ContextWith<'objects'>, query: PredictionListQuery): Promise<Prediction[]> {
  return ctx.store.objects.listObjects(ctx.tenantId, 'prediction', query);
}

export async function predictionBaserate(ctx: ContextWith<'objects'>, classTag: string): Promise<PredictionBaserate> {
  return ctx.store.objects.predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: ContextWith<'objects'>, id: number): Promise<Prediction | null> {
  return ctx.store.objects.objectById(ctx.tenantId, 'prediction', id);
}

export async function predictionClose(
  ctx: ContextWith<'objects'>,
  id: number,
  close: Omit<PredictionClose, 'actor'>,
): Promise<Prediction> {
  return ctx.store.objects.closeObject(ctx.tenantId, 'prediction', id, { ...close, actor: ctx.actor.subject });
}
