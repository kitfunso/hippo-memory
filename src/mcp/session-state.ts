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
export const lastRecalledIds = new Map<string, string[]>();
export const autoSleepInFlight = new Set<string>();

export function resolveClientKey(ctx: { clientKey?: string; tenantId: string } | undefined): string {
  if (ctx?.clientKey) return ctx.clientKey;
  if (ctx?.tenantId) return `stdio-${process.pid}:${ctx.tenantId}`;
  return `stdio-${process.pid}:default`;
}
