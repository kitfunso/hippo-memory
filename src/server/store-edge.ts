// The server's one capability check inside a handler: the route table proves the group a route row names, and a
// request body that needs the last-recall group proves it here, so the api and the memory routes decide nothing.
import type { Context, ContextWith } from '../api/types.js';
import { hasGroup } from '../store/port.js';
import { HttpError } from '../util/http-util.js';

const NO_LAST_RECALL = 'this store keeps no last recall: send the ids your recall returned';

/** `ctx` typed with the last-recall group set; a store without it answers 501, and the caller can still send ids. */
export function withLastRecall(ctx: Context): ContextWith<'lastRecall'> {
  if (!hasGroup(ctx.store, 'lastRecall')) throw new HttpError(501, NO_LAST_RECALL);
  return { ...ctx, store: ctx.store };
}
