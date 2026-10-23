// The checks every caller call shares: ids, project, the session's owner and the pilot arm, all from the request, never
// the server's env or folder.
import { BadRequestError } from '../../base/errors/api-errors.js';
import { ownerOrSubject, type Context } from '../../api/types.js';
import { MAX_ID_LEN } from '../../base/util/limits.js';
import { sessionPilotArm } from '../../api/pilot-arm.js';
import { ledgerReachOf } from '../../api/ledger-db.js';
import { assertCallerIds, type CallerProject } from '../../api/prompt-hook.js';
import { assertCallerProject, projectNames } from '../../base/scope/project-identity.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';
import { bindSessionOwner } from '../../api/auth/session-owners.js';
import { fitWorkingState, WORKING_STATE_CAPS, type WorkingState } from '../../domain/capture/working-state.js';
import type { ContinuityKey } from '../../store/port/types.js';

/**
 * Checks the ids, then binds the session to the caller's owner (a ConflictError when another owner holds it). Returns
 * the key the call's rows go under.
 */
export async function bindCaller(ctx: Context, sessionId: string, project: CallerProject): Promise<ContinuityKey> {
  assertCallerIds(sessionId, project);
  if (sessionId.trim() === '') throw new BadRequestError('session id: required');
  // A '' project would stamp user-global rows; a rewritten one would split a project.
  assertCallerProject(project);
  await bindSessionOwner(ctx, sessionId);
  return { owner: ownerOrSubject(ctx.actor), project: projectNames(project) };
}

/** Read only: the session's first prompt booked its arm, and a holdout session gets nothing from hippo. */
export async function callerInHoldout(ctx: Context, sessionId: string): Promise<boolean> {
  const reach = ledgerReachOf(ctx, true);
  const armOpts = { reach, ownTenantOnly: true };
  return (await sessionPilotArm(ctx.tenantId, sessionId, false, armOpts)) === 'holdout';
}

/**
 * Refuses a field past the cap a transcript read gives, naming it; scrubbed again, since the caller's scrub is not
 * trusted, then cut back to the cap.
 */
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
  if (trigger !== null && trigger.length > MAX_ID_LEN) {
    throw new BadRequestError(`trigger: at most ${MAX_ID_LEN} characters`);
  }
}

export function assertRequestId(requestId: string): void {
  if (requestId.trim() === '') throw new BadRequestError('request id: required');
  if (requestId.length > MAX_ID_LEN) throw new BadRequestError(`request id: at most ${MAX_ID_LEN} characters`);
}
