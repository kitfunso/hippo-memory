import { requireGroup, storeFor } from '../store/index.js';
import type { GraphRows } from '../store/port.js';
import type { Context } from './types.js';

/** The entity/relation rows behind GET /v1/graph, as the caller's role, scopes and owner may see them. */
export async function graphRows(ctx: Context, query: { entity?: string; limit: number }): Promise<GraphRows> {
  const { role, scopes, owner } = ctx.actor;
  return requireGroup(storeFor(ctx), 'graphReads').graphRows(ctx.tenantId, { ...query, reader: { role, scopes, owner } });
}
