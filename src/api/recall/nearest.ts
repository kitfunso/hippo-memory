// The nearest-row read a CLI on this host asks of the served store, whose vector graph answers it; it reaches no row
// the caller's own recall could not.
import { BadRequestError, ForbiddenError } from '../../base/errors/api-errors.js';
import { assertScopeRequestAllowed, type RecallScopeFilter } from '../../base/scope/recall-scope.js';
import type { VectorCandidateSpec } from '../../store/port/vectors.js';
import { sharedStoreOf, type Context } from '../types.js';

/** The ids of the rows nearest `vector` that pass `spec`, nearest first. Refuses a spec for another tenant, a scope the
 * caller may not request, and on a shared store a spec that names no project, as recall refuses them. */
export async function nearestMemoryIds(
  ctx: Context,
  vector: readonly number[],
  spec: VectorCandidateSpec,
): Promise<string[]> {
  if (spec.tenantId !== ctx.tenantId) throw new ForbiddenError("a nearest-row read reaches only the caller's tenant");
  for (const scope of namedScopes(spec.scope)) assertScopeRequestAllowed(ctx.actor, scope);
  if (sharedStoreOf(ctx) && spec.origin === undefined) {
    throw new BadRequestError("a nearest-row read on a shared store must name the caller's project");
  }
  return (await ctx.store.vectors.nearestEntries(vector, spec)).map((entry) => entry.id);
}

function namedScopes(filter: RecallScopeFilter | undefined): string[] {
  if (filter === undefined) return [];
  const own = filter.mode === 'exact' ? undefined : filter.ownScope;
  const value = filter.mode === 'default-deny' ? undefined : filter.value;
  return [own, value].filter((scope): scope is string => scope !== undefined);
}
