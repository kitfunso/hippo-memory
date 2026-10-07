// PreCompact for a caller on another machine: the record and the owner's snapshot go under its tenant and project; only a refused bind or the holdout arm withholds the instruction.
import type { Context } from '../api/types.js';
import { markSnapshotSaved, PRE_COMPACT_INSTRUCTION, startCompaction } from '../compaction-record.js';
import { errorMessage, log } from '../log.js';
import type { CallerProject } from '../prompt-hook.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot, type ContinuityKey } from '../store/sessions.js';
import { assertTrigger, bindCaller, callerInHoldout, checkedWorkingState, withCallerDb } from './caller-session.js';
import { mergeWorkingState, type WorkingState } from './working-state.js';

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
function logged<T>(what: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    log.warn(`pre-compact: ${what}: ${errorMessage(err)}`);
    return null;
  }
}

export function preCompactForCaller(ctx: Context, req: CallerPreCompactRequest): CallerHookOutput {
  assertTrigger(req.trigger);
  const state = checkedWorkingState(req.workingState);
  const key = bindCaller(ctx, req.sessionId, req.project);
  if (callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const start = { sessionId: req.sessionId, originProject: req.project.name, trigger: req.trigger, cwd: null, transcriptPath: null };
  const recordId = logged('compaction record not started', () => withCallerDb(ctx, (db) => startCompaction(db, ctx.tenantId, start)));
  if (state !== null && saveOwnerSnapshot(ctx, req.sessionId, key, state) && recordId !== null) {
    // Marked under ctx.tenantId, which the environment's tenant may not be.
    logged('compaction record not marked with its snapshot', () => withCallerDb(ctx, (db) => markSnapshotSaved(db, ctx.tenantId, recordId)));
  }
  return { stdout: PRE_COMPACT_INSTRUCTION };
}

/** True when the owner's snapshot was saved. */
function saveOwnerSnapshot(ctx: Context, sessionId: string, key: ContinuityKey, state: WorkingState): boolean {
  const existing = logged('snapshot not loaded', () => loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, key));
  const merged = mergeWorkingState(state, existing, sessionId);
  if (merged === null) return false;
  const snapshot = { ...merged, source: 'pre-compact', session_id: sessionId };
  return logged('snapshot not saved', () => saveActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, snapshot, key)) !== null;
}
