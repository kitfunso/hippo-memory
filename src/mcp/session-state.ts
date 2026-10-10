// Per-process state the MCP tools share across calls: recall rings, last recalled ids, auto-sleep runs.

import { DEFAULT_TENANT_ID } from '../util/env.js';
import { resetSessionRings } from '../api/recall-record.js';

/** Test-only: reset the MCP recall rings. Call from beforeEach. */
export function _resetSessionRecallHistoryMcpForTests(): void {
  resetSessionRings('mcp');
}

// Last recalled IDs per client for outcome feedback, so two HTTP-MCP clients on one tenant cannot poison each other: key is `ctx.clientKey` (hash of
// bearer+remoteAddr over HTTP), else 'stdio-${pid}', else `${tenantId}:default` for a McpContext built in tests.
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
export { autoSleepInFlight } from '../api/auto-sleep.js';

export function resolveClientKey(ctx: { clientKey?: string; tenantId: string; project?: { name: string } } | undefined): string {
  const base = ctx?.clientKey ? ctx.clientKey : `stdio-${process.pid}:${ctx?.tenantId || DEFAULT_TENANT_ID}`;
  return ctx?.project ? `${base}:${ctx.project.name}` : base;
}
