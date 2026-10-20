import type { SavableDescriptor } from '../../domain/objects/descriptor.js';
import { saveObject } from '../../domain/objects/lifecycle.js';
import type { ObjectByKind, SavableKind } from '../../base/records/object-types.js';
import type { Objects } from '../../store/port.js';
import type { Context } from '../types.js';

/** The request store's object group; the dispatcher has already answered 501 for a store without it. */
export function objectsOf(ctx: Context): Objects {
  return ctx.store.objects;
}

/** Saves through the request's store as the authenticated caller. */
export function saveFor<K extends SavableKind, W>(
  ctx: Context,
  d: SavableDescriptor<K, W>,
  write: W,
): Promise<ObjectByKind[K]> {
  return saveObject(
    objectsOf(ctx),
    d,
    { baseHalfLifeDays: ctx.config.defaultHalfLifeDays, tenantId: ctx.tenantId, actor: ctx.actor.subject },
    write,
  );
}
