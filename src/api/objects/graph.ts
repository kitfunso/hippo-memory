import { BadRequestError } from '../../core/api-errors.js';
import { MAX_ENTITY_NAME_LEN } from '../../store/graph-rows.js';
import type { GraphRows } from '../../store/port.js';
import type { ContextWith } from '../types.js';

/** The entity a graph read focuses on. Capped at the 512 entity-name cap, not the id-shaped 256, so a long decision or
 * policy name stays focusable. */
export function graphEntityOf(raw: string | null): string | undefined {
  if (raw !== null && raw.length > MAX_ENTITY_NAME_LEN) {
    throw new BadRequestError(`entity exceeds the ${MAX_ENTITY_NAME_LEN}-character cap`);
  }
  return raw ?? undefined;
}

/** The entity/relation rows behind GET /v1/graph, as the caller's role, scopes and owner may see them. */
export async function graphRows(
  ctx: ContextWith<'graphReads'>,
  query: { entity?: string; limit: number },
): Promise<GraphRows> {
  const { role, scopes, owner } = ctx.actor;
  return ctx.store.graphReads.graphRows(ctx.tenantId, { ...query, reader: { role, scopes, owner } });
}
