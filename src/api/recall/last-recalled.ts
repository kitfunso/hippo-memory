// The ids each tool client was last shown, so its next outcome lands on them. Keyed per client, so two HTTP-MCP clients
// on one tenant cannot poison each other.

import { DEFAULT_TENANT_ID } from '../../util/env.js';

const MAX_RECALL_CLIENTS = 4096;

// The caller names the project half of each key, so a set past the cap drops the client that recalled longest ago.
class RecentRecalls extends Map<string, string[]> {
  override set(key: string, ids: string[]): this {
    this.delete(key);
    super.set(key, ids);
    const oldest = this.keys().next().value;
    if (this.size > MAX_RECALL_CLIENTS && oldest !== undefined) this.delete(oldest);
    return this;
  }
}

export const lastRecalledIds: Map<string, string[]> = new RecentRecalls();

/** The HTTP transport's client key (a hash of bearer and address), else `stdio-<pid>:<tenant>`; a caller's project
 * narrows either. */
export function resolveClientKey(
  ctx: { clientKey?: string; tenantId: string; project?: { name: string } } | undefined,
): string {
  const base = ctx?.clientKey ? ctx.clientKey : `stdio-${process.pid}:${ctx?.tenantId || DEFAULT_TENANT_ID}`;
  return ctx?.project ? `${base}:${ctx.project.name}` : base;
}
