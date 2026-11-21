import { ForbiddenError } from '../base/errors/api-errors.js';
import { assertCallerProject } from '../base/scope/project-identity.js';
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
  // Widened to undefined, so a JS gate that returns nothing refuses instead of letting the write run.
  const answer: string | null | undefined = await gate({
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    project: project?.name ?? null,
  });
  if (answer === null) return;
  throw new ForbiddenError(answer || DEFAULT_REFUSAL);
}
