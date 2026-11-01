// Work an api call starts and does not wait on goes to the keeper its root set on the Context.
import { DetachedSet } from '../base/util/detached-set.js';
import type { DetachedWork } from '../domain/search/embed-memories.js';
import type { Context } from './types.js';

/** Runs `start` with the root's keeper of detached work; a context with none gets one of the
 * call's own, which settles before the call returns, so no work outlives the call unowned. */
export async function withDetached<T>(
  ctx: Pick<Context, 'detached'>,
  start: (detached: DetachedWork) => T | Promise<T>,
): Promise<T> {
  if (ctx.detached !== undefined) return start(ctx.detached);
  const own = new DetachedSet();
  try {
    return await start(own);
  } finally {
    await own.settle();
  }
}
