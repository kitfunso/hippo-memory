import { ForbiddenError } from '../base/errors/api-errors.js';
import { assertCallerProject } from '../base/scope/project-identity.js';
import { type JsonValue, isJsonString } from '../base/util/json.js';
import type { Context } from './types.js';

const DEFAULT_REFUSAL = 'this caller may not write under this project';

/** Validates the caller's project, then asks the server's gate; no gate checks nothing. */
export async function admitProjectWrite(
  ctx: Pick<Context, 'tenantId' | 'actor' | 'projectWriteGate'>,
  project: { readonly name: string; readonly aliases?: readonly string[] } | null,
): Promise<void> {
  const gate = ctx.projectWriteGate;
  if (gate === undefined) return;
  // Validation first, so a malformed name answers 400 and never reaches the gate.
  if (project !== null) assertCallerProject(project);
  // Widened to unknown, so a JS gate that returns nothing or a non-string refuses instead of letting the write run.
  const answer: unknown = await gate({
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    project: project?.name ?? null,
  });
  if (answer === null) return;
  // SAFETY: a JS gate may return any value; isJsonString is the check that it is text.
  const text = isJsonString(answer as JsonValue) ? (answer as string) : '';
  throw new ForbiddenError(text === '' ? DEFAULT_REFUSAL : text);
}
