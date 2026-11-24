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
import type { ContextOptions, ContextResult, ContinuityMode } from './context-types.js';
import { type Context, ownerOrSubject } from '../types.js';
import type { ContinuityKey } from '../../base/ports/store/types.js';
import { CONTINUITY_EVENT_LIMIT } from '../continuity/continuity.js';
import { isPointerSafeId } from '../../base/util/session-id.js';

/** The task-state sections printed ahead of the memories, and the budget left once they are
 * paid. */
export interface TaskSections {
  activeSnapshot: TaskSnapshot | null;
  shownSnapshot: TaskSnapshot | null;
  snapshotMode: ContinuityMode;
  shownHandoff: SessionHandoff | null;
  omittedHandoff: SessionHandoff | null;
  handoffMode: ContinuityMode;
  shownEvents: SessionEvent[];
  left: number;
}

interface RawTaskState {
  readonly snapshot: TaskSnapshot | null;
  readonly handoff: SessionHandoff | null;
  readonly events: readonly SessionEvent[];
}

const NO_TASK_STATE: RawTaskState = { snapshot: null, handoff: null, events: [] };

async function loadRawTaskState(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
): Promise<RawTaskState> {
  if (!plan.hasLocalTaskState) return NO_TASK_STATE;
  const { store } = plan.local;
  const key: ContinuityKey | null = plan.sharedStore
    ? { owner: ownerOrSubject(ctx.actor), project: projectNames(plan.currentProject) }
    : null;
  const block = await store.continuity(ctx.tenantId, CONTINUITY_EVENT_LIMIT, key);
  const snapshot = freshActiveSnapshot(block.activeSnapshot, { sessionId: opts.currentSessionId });
  if (snapshot?.sessionId) {
    return { snapshot, handoff: block.sessionHandoff, events: block.recentSessionEvents };
  }
  const unfinished = {
    sessionId: null,
    unfinishedOnly: true,
    maxAgeMs: SNAPSHOT_AMBIENT_MAX_AGE_MS,
    scopeFilter: 'default-deny',
  } as const;
  const { sessions } = store;
  const handoff = sessions && (await sessions.read(ctx.tenantId, 'handoff', unfinished, key));
  return { snapshot, handoff: handoff ?? null, events: [] };
}

export async function loadTaskSections(
  ctx: Context,
  opts: ContextOptions,
  plan: ContextPlan,
  startLeft: number,
): Promise<TaskSections> {
  const { exactScope, ownScope, cost } = plan;
  const { pays, left } = tokenPurse(startLeft);
  const admits = (r: { scope?: string | null }): boolean =>
    passesScopeFilterForRecall(r.scope ?? null, exactScope, ownScope);
  const raw = await loadRawTaskState(ctx, opts, plan);
  const activeSnapshot = raw.snapshot && admits(raw.snapshot) ? raw.snapshot : null;
  const eligibleHandoff = raw.handoff && admits(raw.handoff) ? raw.handoff : null;
  const { sessionHandoff, omittedHandoff } = splitHandoff(opts, eligibleHandoff);
  const snapshotMode = continuityModeFor(opts, plan, activeSnapshot?.sessionId, 'pointer');
  const handoffMode = continuityModeFor(opts, plan, sessionHandoff?.sessionId, 'full');
  const shownSnapshot =
    activeSnapshot && (!cost || pays(cost.snapshot(activeSnapshot, snapshotMode)))
      ? activeSnapshot
      : null;
  const shownHandoff =
    sessionHandoff && (!cost || pays(cost.handoff(sessionHandoff, handoffMode)))
      ? sessionHandoff
      : null;
  const recentSessionEvents =
    shownSnapshot !== null && snapshotMode === 'pointer' ? [] : raw.events.filter(admits);
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
  return {
    activeSnapshot,
    shownSnapshot,
    snapshotMode,
    shownHandoff,
    omittedHandoff,
    handoffMode,
    shownEvents,
    left: left(),
  };
}

function splitHandoff(
  opts: ContextOptions,
  eligible: SessionHandoff | null,
): { sessionHandoff: SessionHandoff | null; omittedHandoff: SessionHandoff | null } {
  const own = Boolean(opts.currentSessionId) && eligible?.sessionId === opts.currentSessionId;
  const omit = opts.ownHandoffOnly && eligible && !own;
  return omit
    ? { sessionHandoff: null, omittedHandoff: eligible }
    : { sessionHandoff: eligible, omittedHandoff: null };
}

function continuityModeFor(
  opts: ContextOptions,
  plan: ContextPlan,
  sessionId: string | null | undefined,
  noIdMode: ContinuityMode,
): ContinuityMode {
  if (opts.continuity !== 'pointer' || plan.sharedStore) return 'full';
  if (!sessionId) return noIdMode;
  return sessionId === opts.currentSessionId || !isPointerSafeId(sessionId) ? 'full' : 'pointer';
}

/** The mode is left out of a full print, so every reader's result reads as before. */
export function pointerModes(s: TaskSections): Pick<ContextResult, 'snapshotMode' | 'handoffMode'> {
  const modes: Pick<ContextResult, 'snapshotMode' | 'handoffMode'> = {};
  if (s.shownSnapshot && s.snapshotMode === 'pointer') modes.snapshotMode = 'pointer';
  if (s.shownHandoff && s.handoffMode === 'pointer') modes.handoffMode = 'pointer';
  return modes;
}
