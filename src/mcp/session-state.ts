// Per-process state the MCP tools share across calls: recall rings, last recalled ids, auto-sleep runs.

import type { RingBuffer } from '../recall-history.js';

// Per-(tenant, session) recall-history rings for the MCP pipeline, kept apart from
// the CLI/HTTP rings: each pipeline owns its rings, with no IPC between them.
export const sessionRecallHistoryMcp = new Map<string, RingBuffer>();

/** Test-only: reset the module-level recall-history Map. Call from beforeEach. */
export function __resetSessionRecallHistoryMcp(): void {
  sessionRecallHistoryMcp.clear();
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

export function resolveClientKey(ctx: { clientKey?: string; tenantId: string; project?: { name: string } } | undefined): string {
  const base = ctx?.clientKey ? ctx.clientKey : `stdio-${process.pid}:${ctx?.tenantId || 'default'}`;
  return ctx?.project ? `${base}:${ctx.project.name}` : base;
}
