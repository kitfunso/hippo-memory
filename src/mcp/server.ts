#!/usr/bin/env node
/**
 * Hippo Memory MCP server: exposes hippo memory as MCP tools over stdio via the programmatic API (no child process).
 * Usage: hippo mcp (or npx hippo-memory
 * mcp). */

export { findHippoRoot, mcpErrorResponse, type McpRequest, type McpResponse, type McpContext } from './protocol.js';
export { handleMcpRequest } from './request.js';
export { startStdioLoop } from './stdio.js';
import { envMcpStdio } from '../util/env.js';
import { startStdioLoop } from './stdio.js';

// Auto-start only as the main module (node dist/mcp/server.js or the cli's import('./mcp/server.js')); importing it
// elsewhere (the HTTP/SSE wiring) must not
// start stdio. Fallback: HIPPO_MCP_STDIO=1 or argv1 ending in /mcp/server.js also starts it.
const isMainModule = (() => {
  const argv1 = process.argv[1] ?? '';
  if (argv1.endsWith('mcp/server.js') || argv1.endsWith('mcp\\server.js')) return true;
  if (envMcpStdio()) return true;
  // ESM main-module check
  const mainUrl = `file://${argv1.replace(/\\/g, '/')}`;
  return import.meta.url === mainUrl || import.meta.url === `file:///${argv1.replace(/\\/g, '/')}`;
})();

if (isMainModule) {
  // The CLI owns the store build, so running this file directly opens the same store `hippo mcp` does.
  const { cliStdioHost } = await import('../cli/api-context.js');
  startStdioLoop(cliStdioHost());
}
