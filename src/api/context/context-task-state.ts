// The snapshot, handoff and events a context call shows.
import {
  freshActiveSnapshot,
  SNAPSHOT_AMBIENT_MAX_AGE_MS,
} from '../../base/session/session-snapshot.js';
import type { SessionEvent, TaskSnapshot } from '../../base/ports/store/sessions.js';
import type { SessionHandoff } from '../../base/session/handoff.js';
import { tokenPurse } from '../../base/util/token-text.js';
import { projectNames } from '../../base/scope/project-identity.js';
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import type { ContextPlan } from './context-plan.js';
import type { ContextOptions } from './context-types.js';
import { type Context, ownerOrSubject } from '../types.js';
import type { ContinuityKey } from '../../base/ports/store/types.js';
import { CONTINUITY_EVENT_LIMIT } from '../continuity/continuity.js';

/** The task-state sections printed ahead of the memories, and the budget left once they are
 * paid. */
export interface TaskSections {
  activeSnapshot: TaskSnapshot | null;
  shownSnapshot: TaskSnapshot | null;
  shownHandoff: SessionHandoff | null;
  shownEvents: SessionEvent[];
  left: number;
}

interface RawTaskState {
  readonly snapshot: TaskSnapshot | null;
  readonly handoff: SessionHandoff | null;
  readonly events: readonly SessionEvent[];
}

const NO_TASK_STATE: RawTaskState = { snapshot: null, handoff: null, events: [] };

// Keyed on the RAW snapshot: a scope-hidden active session must not fall through to another
// session's ambient handoff.
async function loadRawTaskState(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
): Promise<RawTaskState> {
  if (!plan.hasLocalTaskState) return NO_TASK_STATE;
  const { store } = plan.local;
  // On a shared store task state is one person's, keyed by owner and project so it follows them
  // into their next session.
  const key: ContinuityKey | null = plan.sharedStore
    ? { owner: ownerOrSubject(ctx.actor), project: projectNames(plan.currentProject) }
    : null;
  const block = await store.continuity(ctx.tenantId, CONTINUITY_EVENT_LIMIT, key);
  // Bounded read: an orphaned snapshot ages out of this ambient surface; the owner session's read
  // stays unbounded.
  const snapshot = freshActiveSnapshot(block.activeSnapshot, { sessionId: opts.currentSessionId });
  // The block's handoff and events are the raw snapshot's session's, so they stand only while that
  // snapshot is fresh.
  if (snapshot?.sessionId) {
    return { snapshot, handoff: block.sessionHandoff, events: block.recentSessionEvents };
  }
  // An unfinished handoff's scope is admitted in the read, so a newer denied row can't hide an
  // older eligible one.
  const unfinished = {
    sessionId: null,
    unfinishedOnly: true,
    maxAgeMs: SNAPSHOT_AMBIENT_MAX_AGE_MS,
    scopeFilter: 'default-deny',
  } as const;
  // A store that keeps no session rows has no handoff to offer.
  const sessions = store.hippoDb?.sessions;
  const handoff = sessions && (await sessions.read(ctx.tenantId, 'handoff', unfinished, key));
  return { snapshot, handoff: handoff ?? null, events: [] };
}

// Sections print ahead of the memories, so they are paid first; one that does not fit is dropped,
// as an oversize entry is.
export async function loadTaskSections(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
  startLeft: number,
): Promise<TaskSections> {
  const { exactScope, ownScope, cost } = plan;
  const { pays, left } = tokenPurse(startLeft);
  const rowScope = (r: { scope?: string | null } | null | undefined): string | null =>
    r?.scope ?? null;
  const raw = await loadRawTaskState(ctx, opts, plan);
  // The same envelope rule ambientAdmitEntry applies to memory rows.
  const activeSnapshot =
    raw.snapshot && passesScopeFilterForRecall(rowScope(raw.snapshot), exactScope, ownScope)
      ? raw.snapshot
      : null;
  const sessionHandoff =
    raw.handoff && passesScopeFilterForRecall(rowScope(raw.handoff), exactScope, ownScope)
      ? raw.handoff
      : null;
  const recentSessionEvents = raw.events.filter((e) =>
    passesScopeFilterForRecall(rowScope(e), exactScope, ownScope),
  );
  const shownSnapshot =
    activeSnapshot && (!cost || pays(cost.snapshot(activeSnapshot))) ? activeSnapshot : null;
  const shownHandoff =
    sessionHandoff && (!cost || pays(cost.handoff(sessionHandoff))) ? sessionHandoff : null;
  const shownEvents =
    recentSessionEvents.length > 0 && (!cost || pays(cost.trail(recentSessionEvents)))
      ? recentSessionEvents
      : [];
  plan.obs?.sections(
    Number(shownSnapshot !== null) + Number(shownHandoff !== null) + Number(shownEvents.length > 0),
    Number(activeSnapshot !== shownSnapshot) +
      Number(sessionHandoff !== shownHandoff) +
      Number(recentSessionEvents.length !== shownEvents.length),
  );
  return { activeSnapshot, shownSnapshot, shownHandoff, shownEvents, left: left() };
}
