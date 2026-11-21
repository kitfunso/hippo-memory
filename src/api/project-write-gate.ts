import { ForbiddenError } from '../base/errors/api-errors.js';
import { assertCallerProject } from '../base/scope/project-identity.js';
import { DeadlineError, withDeadline } from '../base/util/deadline.js';
import { HttpError } from '../base/errors/http-errors.js';
import { type JsonValue, isJsonString } from '../base/util/json.js';
import { errorFields, log } from '../base/util/log.js';
import { isStoreBusy } from '../base/util/store-blocked.js';
import type { Context } from './types.js';

const DEFAULT_REFUSAL = 'this caller may not write under this project';
const DEFAULT_GATE_DEADLINE_MS = 5000;

/** Validates the caller's project, then asks the server's gate; no gate checks nothing. */
export async function admitProjectWrite(
  ctx: Pick<Context, 'tenantId' | 'actor' | 'projectWriteGate' | 'projectWriteGateTimeoutMs'>,
  project: { readonly name: string; readonly aliases?: readonly string[] } | null,
): Promise<void> {
  const gate = ctx.projectWriteGate;
  if (gate === undefined) return;
  // Validation first, so a malformed name answers 400 and never reaches the gate.
  if (project !== null) assertCallerProject(project);
  const t = ctx.projectWriteGateTimeoutMs;
  const deadlineMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_GATE_DEADLINE_MS;
  // A frozen copy with its own frozen scopes, so a JS gate that mutates its argument cannot change the request's actor.
  const scopes = ctx.actor.scopes;
  const actor = Object.freeze({
    ...ctx.actor,
    ...(scopes !== undefined && { scopes: Object.freeze([...scopes]) }),
  });
  // Widened to unknown, so a JS gate that returns nothing or a non-string refuses instead of letting the write run.
  let answer: unknown;
  try {
    answer = await withDeadline(deadlineMs, (signal) =>
      gate({ tenantId: ctx.tenantId, actor, project: project?.name ?? null, signal }),
    );
  } catch (err) {
    if (err instanceof DeadlineError) {
      log.error(`project write gate: ${err.message}`, errorFields(err));
      throw new HttpError(503, 'project write gate unavailable');
    }
    // A busy store keeps its 503 and Retry-After; its text is fixed, so no gate text leaks.
    if (isStoreBusy(err)) throw err;
    log.error('project write gate: the gate threw', errorFields(err));
    // A plain Error answers 500; an HttpError or ApiError from the gate would keep its own status and text.
    throw new Error('project write gate failed', { cause: err });
  }
  if (answer === null) return;
  // SAFETY: a JS gate may return any value; isJsonString is the check that it is text.
  const text = isJsonString(answer as JsonValue) ? (answer as string) : '';
  throw new ForbiddenError(text === '' ? DEFAULT_REFUSAL : text);
}
