// SessionEnd for a caller on another machine: the owner's handoff, then the owner's snapshot for
// the session closed, both under its tenant and project.
import { BadRequestError } from '../../base/errors/api-errors.js';
import type { EntryContext } from '../../api/types.js';
import type { HandoffEvidence } from '../../base/session/handoff.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import { bindCaller, checkedWorkingState } from './caller-session.js';
import { snapshotFields, type WorkingState } from '../../base/session/working-state.js';
import { withEntryInfra } from '../entry-infra.js';
import { withHippoDb } from '../../api/hippo-db-context.js';
import { closeCallerSession, type CallerSessionEndResult } from '../../api/session-end.js';

export type CallerEvidence = Pick<HandoffEvidence, 'gitRef' | 'dirtyTree' | 'testStatus'>;

export interface CallerSessionEndRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** Read off the transcript at session end; the handoff's source when the owner has no snapshot
   * for the session. */
  readonly workingState: WorkingState | null;
  /** The git state the caller saw when the session ended. */
  readonly evidence: CallerEvidence | null;
}

const TEST_STATUSES: ReadonlySet<string> = new Set(['pass', 'fail', 'unknown']);

/** Only the three fields a caller may send: `derivedFrom` is the handoff writer's to set. */
function checkedEvidence(evidence: CallerEvidence | null): CallerEvidence | null {
  if (evidence === null) return null;
  const { gitRef = null, dirtyTree = null, testStatus = null } = evidence;
  // `git rev-parse HEAD` gives 40 hex, or 64 in a SHA-256 repository.
  if (gitRef !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(gitRef)) {
    throw new BadRequestError('evidence gitRef: 40 or 64 lowercase hex characters or null');
  }
  if (dirtyTree !== null && dirtyTree !== true && dirtyTree !== false) {
    throw new BadRequestError('evidence dirtyTree: true, false or null');
  }
  if (testStatus !== null && !TEST_STATUSES.has(testStatus)) {
    throw new BadRequestError('evidence testStatus: pass, fail, unknown or null');
  }
  return { gitRef, dirtyTree, testStatus };
}

/** Call on a session's final end only, since it closes the snapshot. */
export async function sessionEndHandoffForCaller(
  given: EntryContext,
  req: CallerSessionEndRequest,
): Promise<CallerSessionEndResult> {
  const ctx = withHippoDb(withEntryInfra(given));
  const state = checkedWorkingState(req.workingState);
  const evidence = checkedEvidence(req.evidence);
  const key = await bindCaller(ctx, req.sessionId, req.project);
  const derived = state === null ? null : snapshotFields(state);
  return closeCallerSession(ctx, key, { sessionId: req.sessionId, evidence, derived });
}
