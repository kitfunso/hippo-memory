// Where-you-left-off for `hippo current show` and `hippo session latest`: the active task snapshot
// with the session events that follow it, read from hippo.db's local tier.

import type { SessionEvent, TaskSnapshot } from '../../base/records/sessions.js';
import type { HippoDbContext } from '../hippo-db-context.js';

export interface LatestContinuity {
  snapshot: TaskSnapshot | null;
  events: SessionEvent[];
}

/** The active snapshot plus recent events for `sessionId`, falling back to the snapshot's own
 * session. */
export async function continuityLatest(
  ctx: HippoDbContext,
  opts: { sessionId?: string; limit: number },
): Promise<LatestContinuity> {
  const { sessions } = ctx.store.hippoDb;
  const snapshot = await sessions.loadSnapshot(ctx.tenantId, {}, null);
  const events = await sessions.read(ctx.tenantId, 'event', {
    sessionId: opts.sessionId || snapshot?.sessionId || undefined,
    limit: opts.limit,
  });
  return { snapshot, events };
}
