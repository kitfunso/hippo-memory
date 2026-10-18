// PreCompact for a caller on another machine: the record and the owner's snapshot go under its tenant and project;
// only a refused bind or the holdout arm withholds the instruction.
import type { Context } from '../api/types.js';
import { PRE_COMPACT_INSTRUCTION } from './compaction-record.js';
import { errorMessage, log, errorFields } from '../util/log.js';
import type { CallerProject } from '../api/prompt-hook.js';
import { assertTrigger, bindCaller, callerInHoldout, checkedWorkingState } from './caller-session.js';
import { mergeWorkingState, type WorkingState } from './working-state.js';
import type { ContinuityKey } from '../store/port/types.js';

export interface CallerPreCompactRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  readonly trigger: string | null;
  /** What the caller read off its transcript; null when nothing was derivable. */
  readonly workingState: WorkingState | null;
}

export interface CallerHookOutput {
  /** What the hook prints; '' prints nothing. */
  readonly stdout: string;
}

/** A failed step is logged and the instruction still goes out, as the local hook prints it before any store work. */
async function logged<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    log.warn(`pre-compact: ${what}: ${errorMessage(err)}`, errorFields(err));
    return null;
  }
}

export async function preCompactForCaller(ctx: Context, req: CallerPreCompactRequest): Promise<CallerHookOutput> {
  assertTrigger(req.trigger);
  const state = checkedWorkingState(req.workingState);
  const key = await bindCaller(ctx, req.sessionId, req.project);
  if (callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const start = {
    sessionId: req.sessionId,
    originProject: req.project.name,
    trigger: req.trigger,
    cwd: null,
    transcriptPath: null,
  };
  const { compactions } = ctx.store;
  const recordId = await logged('compaction record not started', () => compactions.start(ctx.tenantId, start));
  if (state !== null && (await saveOwnerSnapshot(ctx, req.sessionId, key, state)) && recordId !== null) {
    // Marked under ctx.tenantId, which the environment's tenant may not be.
    await logged('compaction record not marked with its snapshot', () =>
      compactions.markSnapshotSaved(ctx.tenantId, recordId),
    );
  }
  return { stdout: PRE_COMPACT_INSTRUCTION };
}

/** True when the owner's snapshot was saved. */
async function saveOwnerSnapshot(
  ctx: Context,
  sessionId: string,
  key: ContinuityKey,
  state: WorkingState,
): Promise<boolean> {
  const { sessions } = ctx.store;
  const existing = await logged('snapshot not loaded', () => sessions.loadSnapshot(ctx.tenantId, key));
  const merged = mergeWorkingState(state, existing, sessionId);
  if (merged === null) return false;
  const snapshot = { ...merged, source: 'pre-compact', session_id: sessionId };
  const saved = await logged('snapshot not saved', () => sessions.saveSnapshot(ctx.tenantId, snapshot, key));
  return saved !== null;
}
