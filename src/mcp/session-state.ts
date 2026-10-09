// Per-process state the MCP tools share across calls: recall rings, last recalled ids, auto-sleep runs.

import { resetSessionRings } from '../api/recall-record.js';

/** Test-only: reset the MCP recall rings. Call from beforeEach. */
export function __resetSessionRecallHistoryMcp(): void {
  resetSessionRings('mcp');
}

// ── Track last recalled IDs for outcome feedback ──
//
// Keyed per-client so two HTTP-MCP clients hitting the same tenant cannot
// poison each other's outcome feedback. The key is `ctx.clientKey` when the
// transport supplies one (HTTP-MCP via src/server.ts builds
// hash(bearer+remoteAddr)); stdio and any caller without a clientKey falls
// back to `'stdio-${pid}'` (one process = one client) or
// `${tenantId}:default` if a McpContext is constructed in tests without a
// pid-bound transport.
export const MAX_RECALL_CLIENTS = 4096;

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
  const base = ctx?.clientKey ? ctx.clientKey : `stdio-${process.pid}:${ctx?.tenantId || 'default'}`;
  return ctx?.project ? `${base}:${ctx.project.name}` : base;
}
