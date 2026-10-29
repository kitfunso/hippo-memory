// PreCompact for a caller on another machine: the record and the owner's snapshot go under its
// tenant and project; only a refused bind or the holdout arm withholds the instruction.
import type { ContextWith, EntryContext } from '../../api/types.js';
import { callerPreCompact } from '../../api/pre-compact.js';
import { PRE_COMPACT_INSTRUCTION } from './compaction-record.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import {
  assertTrigger,
  bindCaller,
  callerInHoldout,
  checkedWorkingState,
} from './caller-session.js';
import type { WorkingState } from '../../base/session/working-state.js';
import { withEntryInfra } from '../entry-infra.js';

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

/** A failed store step is logged and the instruction still goes out, as the local hook prints it
 * before any store work. */
export async function preCompactForCaller(
  given: EntryContext<ContextWith<'compactions' | 'sessions'>>,
  req: CallerPreCompactRequest,
): Promise<CallerHookOutput> {
  const ctx = withEntryInfra(given);
  assertTrigger(req.trigger);
  const derived = checkedWorkingState(req.workingState);
  const key = await bindCaller(ctx, req.sessionId, req.project);
  if (await callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const start = {
    sessionId: req.sessionId,
    originProject: req.project.name,
    trigger: req.trigger,
    cwd: null,
    transcriptPath: null,
  };
  await callerPreCompact(ctx, { start, key, derived });
  return { stdout: PRE_COMPACT_INSTRUCTION };
}
