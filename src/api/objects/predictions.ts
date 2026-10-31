import { predictionMirror } from '../../base/records/prediction.js';
import type {
  PredictionClose,
  PredictionListQuery,
  PredictionSave,
} from '../../base/records/objects.js';
import type { Prediction, SavePredictionOptions } from '../../base/records/objects.js';
import type { PredictionBaserate } from '../../base/ports/store/types.js';
import type { HippoDbContext } from '../hippo-db-context.js';

export async function predictionSave(
  ctx: HippoDbContext,
  input: Omit<PredictionSave, 'actor'>,
): Promise<Prediction> {
  return ctx.store.hippoDb.objects.saveObject(ctx.tenantId, 'prediction', {
    ...input,
    actor: ctx.actor.subject,
  });
}

/** A claim saved with its recall mirror, built under the store root's half-life as the HTTP
 * create route builds it. */
export async function predictionRecord(
  ctx: HippoDbContext,
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
  ctx: HippoDbContext,
  query: PredictionListQuery,
): Promise<Prediction[]> {
  return ctx.store.hippoDb.objects.listObjects(ctx.tenantId, 'prediction', query);
}

export async function predictionBaserate(
  ctx: HippoDbContext,
  classTag: string,
): Promise<PredictionBaserate> {
  return ctx.store.hippoDb.objects.predictionBaserate(ctx.tenantId, classTag, ctx.actor.subject);
}

export async function predictionById(ctx: HippoDbContext, id: number): Promise<Prediction | null> {
  return ctx.store.hippoDb.objects.objectById(ctx.tenantId, 'prediction', id);
}

export async function predictionClose(
  ctx: HippoDbContext,
  id: number,
  close: Omit<PredictionClose, 'actor'>,
): Promise<Prediction> {
  return ctx.store.hippoDb.objects.closeObject(ctx.tenantId, 'prediction', id, {
    ...close,
    actor: ctx.actor.subject,
  });
}
