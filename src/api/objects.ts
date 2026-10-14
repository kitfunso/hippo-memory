import type { SavableDescriptor } from '../objects/descriptor.js';
import { saveObject } from '../objects/lifecycle.js';
import { requireGroup } from '../store/index.js';
import type { ObjectByKind, SavableKind } from '../core/object-types.js';
import type { Objects } from '../store/port.js';
import type { StoreContext } from './types.js';

/** The request store's object group; the dispatcher has already answered 501 for a store without it. */
export function objectsOf(ctx: StoreContext): Objects {
  return requireGroup(ctx.store, 'objects');
}

/** Saves through the request's store as the authenticated caller. */
export function saveFor<K extends SavableKind, W>(ctx: StoreContext, d: SavableDescriptor<K, W>, write: W): Promise<ObjectByKind[K]> {
  return saveObject(objectsOf(ctx), d, { hippoRoot: ctx.hippoRoot, tenantId: ctx.tenantId, actor: ctx.actor.subject }, write);
}
