import { predictionMirror } from '../../base/records/prediction.js';
import type {
  Objects,
  PredictionClose,
  PredictionListQuery,
  PredictionSave,
} from '../../base/ports/store.js';
import type { Context } from '../types.js';
import type { Prediction, SavePredictionOptions } from '../../base/ports/store/objects.js';
import type { PredictionBaserate } from '../../base/ports/store/types.js';

const objectsOf = (ctx: Context): Objects => ctx.store.objects;

export async function predictionSave(
  ctx: Context,
  input: Omit<PredictionSave, 'actor'>,
): Promise<Prediction> {
  return objectsOf(ctx).saveObject(ctx.tenantId, 'prediction', {
    ...input,
    actor: ctx.actor.subject,
  });
}

/** A claim saved with its recall mirror, built under the store root's half-life as the HTTP create route builds it. */
export async function predictionRecord(
  ctx: Context,
  claim: SavePredictionOptions,
): Promise<Prediction> {
  return predictionSave(ctx, {
    ...claim,
    mirror: predictionMirror(
      ctx.tenantId,
      claim,
      ctx.config.defaultHalfLifeDays,
      ctx.infra.clock(),
    ),
  });
}

export async function predictionList(
  ctx: Context,
  query: PredictionListQuery,
): Promise<Prediction[]> {
  return objectsOf(ctx).listObjects(ctx.tenantId, 'prediction', query);
}

export async function predictionBaserate(
  ctx: Context,
  classTag: string,
): Promise<PredictionBaserate> {
  return objectsOf(ctx).predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: Context, id: number): Promise<Prediction | null> {
  return objectsOf(ctx).objectById(ctx.tenantId, 'prediction', id);
}

export async function predictionClose(
  ctx: Context,
  id: number,
  close: Omit<PredictionClose, 'actor'>,
): Promise<Prediction> {
  return objectsOf(ctx).closeObject(ctx.tenantId, 'prediction', id, {
    ...close,
    actor: ctx.actor.subject,
  });
}
