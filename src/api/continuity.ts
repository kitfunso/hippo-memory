// Where-you-left-off: the active task snapshot with the session events that follow it.

import type { SessionEvent, TaskSnapshot } from '../store/port/sessions.js';
import type { Context } from './types.js';

export interface LatestContinuity {
  snapshot: TaskSnapshot | null;
  events: SessionEvent[];
}

/** The active snapshot plus recent events for `sessionId`, falling back to the snapshot's own session. */
export async function continuityLatest(
  ctx: Context,
  opts: { sessionId?: string; limit: number },
): Promise<LatestContinuity> {
  const { sessions } = ctx.store;
  const snapshot = await sessions.loadSnapshot(ctx.tenantId, null);
  const events = await sessions.listEvents(ctx.tenantId, {
    sessionId: opts.sessionId || snapshot?.sessionId || undefined,
    limit: opts.limit,
  });
  return { snapshot, events };
}
