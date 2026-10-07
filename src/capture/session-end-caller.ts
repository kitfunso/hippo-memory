// SessionEnd for a caller on another machine: the owner's handoff, then the owner's snapshot for the session closed, both under its tenant and project.
import { BadRequestError } from '../api-errors.js';
import type { Context } from '../api/types.js';
import type { HandoffEvidence } from '../handoff.js';
import type { CallerProject } from '../prompt-hook.js';
import { writeSessionEndHandoff } from '../store/handoffs.js';
import { closeTaskSnapshotsForSession } from '../store/sessions.js';
import { bindCaller, checkedWorkingState } from './caller-session.js';
import type { WorkingState } from './working-state.js';

export type CallerEvidence = Pick<HandoffEvidence, 'gitRef' | 'dirtyTree' | 'testStatus'>;

export interface CallerSessionEndRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** Read off the transcript at session end; the handoff's source when the owner has no snapshot for the session. */
  readonly workingState: WorkingState | null;
  /** The git state the caller saw when the session ended. */
  readonly evidence: CallerEvidence | null;
}

export interface CallerSessionEndResult {
  /** False when an earlier handoff already covers the session, as on a retry. */
  readonly handoffWritten: boolean;
  readonly snapshotsClosed: number;
}

const TEST_STATUSES: ReadonlySet<string> = new Set(['pass', 'fail', 'unknown']);

/** Only the three fields a caller may send: `derivedFrom` is the handoff writer's to set. */
function checkedEvidence(evidence: CallerEvidence | null): CallerEvidence | null {
  if (evidence === null) return null;
  const { gitRef = null, dirtyTree = null, testStatus = null } = evidence;
  // `git rev-parse HEAD` gives 40 hex, or 64 in a SHA-256 repository.
  if (gitRef !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(gitRef)) throw new BadRequestError('evidence gitRef: 40 or 64 lowercase hex characters or null');
  if (dirtyTree !== null && dirtyTree !== true && dirtyTree !== false) throw new BadRequestError('evidence dirtyTree: true, false or null');
  if (testStatus !== null && !TEST_STATUSES.has(testStatus)) throw new BadRequestError('evidence testStatus: pass, fail, unknown or null');
  return { gitRef, dirtyTree, testStatus };
}

/** Call on a session's final end only, since it closes the snapshot. A failed close throws so the sender retries, and the retry writes no second handoff. */
export function sessionEndHandoffForCaller(ctx: Context, req: CallerSessionEndRequest): CallerSessionEndResult {
  const state = checkedWorkingState(req.workingState);
  const evidence = checkedEvidence(req.evidence);
  const key = bindCaller(ctx, req.sessionId, req.project);
  const handoff = writeSessionEndHandoff(ctx.hippoRoot, ctx.tenantId, req.sessionId, evidence, state, key);
  const snapshotsClosed = closeTaskSnapshotsForSession(ctx.hippoRoot, ctx.tenantId, req.sessionId, 'session-ended', key);
  return { handoffWritten: handoff !== null, snapshotsClosed };
}
