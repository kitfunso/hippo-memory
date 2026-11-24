import { ForbiddenError, memoryNotFoundText, NotFoundError } from '../base/errors/api-errors.js';
import type { MemoryEntry } from '../base/memory/entry.js';
import { isPersonalScope, readerReaches, scopeReaderOf } from '../base/scope/recall-scope.js';
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
type RowGateContext = GateContext & Pick<Context, 'store'>;

/** Validates the caller's project, then asks the server's gate; no gate checks nothing. */
export async function admitProjectWrite(
  ctx: Pick<Context, 'tenantId' | 'actor' | 'projectWriteGate' | 'projectWriteGateTimeoutMs'>,
  project: { readonly name: string; readonly aliases?: readonly string[] } | null,
): Promise<void> {
  if (ctx.projectWriteGate === undefined) return;
  // Validation first, so a malformed name answers 400 and never reaches the gate.
  if (project !== null) assertCallerProject(project);
  const refusal = await askGate(ctx, project?.name ?? null);
  if (refusal !== null) throw new ForbiddenError(refusal);
}

async function askGate(ctx: GateContext, project: string | null): Promise<string | null> {
  const gate = ctx.projectWriteGate;
  if (gate === undefined) return null;
  const t = ctx.projectWriteGateTimeoutMs;
  const deadlineMs = t !== undefined && Number.isFinite(t) && t > 0 ? t : DEFAULT_GATE_DEADLINE_MS;
  const actor = frozenActor(ctx.actor);
  // Widened to unknown, so a JS gate that returns nothing or a non-string refuses instead of letting the write run.
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
    // A busy store keeps its 503 and Retry-After; its text is fixed, so no gate text leaks.
    if (isStoreBusy(err)) throw err;
    log.error('project write gate: the gate threw', errorFields(err));
    // A plain Error answers 500; an HttpError or ApiError from the gate would keep its own status and text.
    throw new Error('project write gate failed', { cause: err });
  }
  if (answer === null) return null;
  // SAFETY: a JS gate may return any value; isJsonString is the check that it is text.
  const text = isJsonString(answer as JsonValue) ? (answer as string) : '';
  return text === '' ? DEFAULT_REFUSAL : text;
}

function rowProject(row: MemoryEntry): string | null {
  return row.originProject || null;
}

export async function admitRowWrite(
  ctx: RowGateContext,
  id: string,
  missing: string = memoryNotFoundText(id),
): Promise<MemoryEntry | undefined> {
  if (ctx.projectWriteGate === undefined) return undefined;
  const [row] = await ctx.store.entriesByIds([id], ctx.tenantId);
  if (row === undefined || !readerReaches(scopeReaderOf(ctx.actor), row.scope)) {
    throw new NotFoundError(missing);
  }
  if (isPersonalScope(row.scope)) return row;
  const refusal = await askGate(ctx, rowProject(row));
  if (refusal !== null) throw new ForbiddenError(refusal);
  return row;
}

export async function refusedRowIds(
  ctx: RowGateContext,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const refused = new Set<string>();
  if (ctx.projectWriteGate === undefined || ids.length === 0) return refused;
  const rows = new Map(
    (await ctx.store.entriesByIds(ids, ctx.tenantId)).map((row) => [row.id, row]),
  );
  const reader = scopeReaderOf(ctx.actor);
  const groups = new Map<string | null, string[]>();
  for (const id of new Set(ids)) {
    const row = rows.get(id);
    if (row === undefined || isPersonalScope(row.scope) || !readerReaches(reader, row.scope)) {
      continue;
    }
    const project = rowProject(row);
    groups.set(project, [...(groups.get(project) ?? []), id]);
  }
  for (const [project, members] of groups) {
    if ((await askGate(ctx, project)) === null) continue;
    for (const id of members) refused.add(id);
  }
  return refused;
}
