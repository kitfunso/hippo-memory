import { ForbiddenError } from '../base/errors/api-errors.js';
import { assertCallerProject } from '../base/scope/project-identity.js';
import { DeadlineError, withDeadline } from '../base/util/deadline.js';
import { HttpError } from '../base/errors/http-errors.js';
import { type JsonValue, isJsonString } from '../base/util/json.js';
import { errorFields, log } from '../base/util/log.js';
import { isStoreBusy } from '../base/util/store-blocked.js';
import { frozenActor } from './frozen-actor.js';
import type { Context } from './types.js';

const DEFAULT_REFUSAL = 'this caller may not write under this project';
const DEFAULT_GATE_DEADLINE_MS = 5000;

type GateContext = Pick<
  Context,
  'tenantId' | 'actor' | 'projectWriteGate' | 'projectWriteGateTimeoutMs'
>;

/** Validates the caller's project, then asks the server's gate; no gate checks nothing. */
export async function admitProjectWrite(
  ctx: GateContext,
  project: { readonly name: string; readonly aliases?: readonly string[] } | null,
): Promise<void> {
  if (ctx.projectWriteGate === undefined) return;
  if (project !== null) assertCallerProject(project);
  const refusal = await askGate(ctx, project?.name ?? null);
  if (refusal !== null) throw new ForbiddenError(refusal);
}

export async function admitOriginWrite(
  ctx: GateContext,
  origin: string | null | undefined,
): Promise<void> {
  if (ctx.projectWriteGate === undefined) return;
  const refusal = await askGate(ctx, origin || null);
  if (refusal !== null) throw new ForbiddenError(refusal);
}

async function askGate(ctx: GateContext, project: string | null): Promise<string | null> {
  const gate = ctx.projectWriteGate;
  if (gate === undefined) return null;
  const t = ctx.projectWriteGateTimeoutMs;
  const deadlineMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_GATE_DEADLINE_MS;
  const actor = frozenActor(ctx.actor);
  let answer: unknown;
  try {
    answer = await withDeadline(deadlineMs, (signal) =>
      gate({ tenantId: ctx.tenantId, actor, project, signal }),
    );
  } catch (err) {
    if (err instanceof DeadlineError) {
      log.error(`project write gate: ${err.message}`, errorFields(err));
      throw new HttpError(503, 'project write gate unavailable');
    }
    if (isStoreBusy(err)) throw err;
    log.error('project write gate: the gate threw', errorFields(err));
    throw new Error('project write gate failed', { cause: err });
  }
  if (answer === null) return null;
  // SAFETY: a JS gate may return any value; isJsonString is the check that it is text.
  const text = isJsonString(answer as JsonValue) ? (answer as string) : '';
  return text === '' ? DEFAULT_REFUSAL : text;
}
