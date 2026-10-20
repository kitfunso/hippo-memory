import { BadRequestError } from '../../base/errors/api-errors.js';
import { MAX_ENTITY_NAME_LEN } from '../../base/records/entity-name.js';
import { buildGraphModel, type GraphModel } from '../../domain/graph/view.js';
import type { Context } from '../types.js';

/** The entity a graph read focuses on. Capped at the 512 entity-name cap, not the id-shaped 256, so a long decision or
 * policy name stays focusable. */
export function graphEntityOf(raw: string | null): string | undefined {
  if (raw !== null && raw.length > MAX_ENTITY_NAME_LEN) {
    throw new BadRequestError(`entity exceeds the ${MAX_ENTITY_NAME_LEN}-character cap`);
  }
  return raw ?? undefined;
}

/** The entity/relation graph behind GET /v1/graph, as the caller's role, scopes and owner may see it. */
export function graphView(ctx: Context, query: { entity?: string; limit: number }): Promise<GraphModel> {
  const { role, scopes, owner } = ctx.actor;
  return buildGraphModel(ctx.store.graphReads, ctx.tenantId, { ...query, reader: { role, scopes, owner } });
}
