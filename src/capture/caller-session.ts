// The checks every caller call shares: ids, project, the session's owner and the pilot arm, all from the request, never the server's env or folder.
import { BadRequestError } from '../core/api-errors.js';
import { ownerOrSubject, type Context } from '../api/types.js';
import { MAX_ID_LEN } from '../util/http-util.js';
import { sessionPilotArm } from '../api/pilot-arm.js';
import { assertCallerIds, type CallerProject } from '../api/prompt-hook.js';
import { assertCallerProject, projectNames } from '../core/project-identity.js';
import { maskEmails, redactSecretsStrict } from '../util/secret-detect.js';
import { bindSessionOwner } from '../api/session-owners.js';
import type { ContinuityKey } from '../store/sessions.js';
import { fitWorkingState, WORKING_STATE_CAPS, type WorkingState } from './working-state.js';

/** Checks the ids, then binds the session to the caller's owner (a ConflictError when another owner holds it). Returns the key the call's rows go under. */
export function bindCaller(ctx: Context, sessionId: string, project: CallerProject): ContinuityKey {
  assertCallerIds(sessionId, project);
  if (sessionId.trim() === '') throw new BadRequestError('session id: required');
  // A '' project would stamp user-global rows; a rewritten one would split a project.
  assertCallerProject(project);
  bindSessionOwner(ctx, sessionId);
  return { owner: ownerOrSubject(ctx.actor), project: projectNames(project) };
}

/** Read only: the session's first prompt booked its arm, and a holdout session gets nothing from hippo. */
export function callerInHoldout(ctx: Context, sessionId: string): boolean {
  return sessionPilotArm(ctx.hippoRoot, ctx.tenantId, sessionId, false, { sharedStore: true, ownTenantOnly: true }) === 'holdout';
}

/** Refuses a field past the cap a transcript read gives, naming it; scrubbed again, since the caller's scrub is not trusted, then cut back to the cap. */
export function checkedWorkingState(state: WorkingState | null): WorkingState | null {
  if (state === null) return null;
  for (const field of ['task', 'summary', 'next_step'] as const) {
    const cap = WORKING_STATE_CAPS[field];
    if (state[field].length > cap) throw new BadRequestError(`working state ${field}: at most ${cap} characters`);
  }
  const scrub = (text: string): string => maskEmails(redactSecretsStrict(text));
  return fitWorkingState({ task: scrub(state.task), summary: scrub(state.summary), next_step: scrub(state.next_step) });
}

export function assertTrigger(trigger: string | null): void {
  if (trigger !== null && trigger.length > MAX_ID_LEN) throw new BadRequestError(`trigger: at most ${MAX_ID_LEN} characters`);
}

export function assertRequestId(requestId: string): void {
  if (requestId.trim() === '') throw new BadRequestError('request id: required');
  if (requestId.length > MAX_ID_LEN) throw new BadRequestError(`request id: at most ${MAX_ID_LEN} characters`);
}
