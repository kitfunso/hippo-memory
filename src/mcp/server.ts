#!/usr/bin/env node
/**
 * Hippo Memory MCP Server
 *
 * Exposes hippo memory as MCP tools over stdio transport.
 * Uses the programmatic API directly (no child process spawning).
 *
 * Usage: hippo mcp (or npx hippo-memory mcp)
 */

export { _resetSessionRecallHistoryMcpForTests } from './session-state.js';
export { findHippoRoot, mcpErrorResponse, type McpRequest, type McpResponse, type McpContext } from './protocol.js';
export { handleMcpRequest } from './request.js';
export { startStdioLoop } from './stdio.js';
import { envMcpStdio } from '../util/env.js';
import { startStdioLoop } from './stdio.js';

// Auto-start when invoked as the main module (node dist/mcp/server.js or via
// the cli's `import('./mcp/server.js')`). Importing this file from another
// module (e.g. src/server.ts wiring up the HTTP/SSE transport) will NOT
// trigger the stdio loop. The cli imports this file specifically to start
// stdio; that import is also `import.meta.url === main`-equivalent because
// it's executed as the program, so we keep a fallback: if HIPPO_MCP_STDIO=1
// or argv1 ends in /mcp/server.js we start.
const isMainModule = (() => {
  try {
    const argv1 = process.argv[1] ?? '';
    if (argv1.endsWith('mcp/server.js') || argv1.endsWith('mcp\\server.js')) return true;
    if (envMcpStdio()) return true;
    // ESM main-module check
    const mainUrl = `file://${argv1.replace(/\\/g, '/')}`;
    return import.meta.url === mainUrl || import.meta.url === `file:///${argv1.replace(/\\/g, '/')}`;
  } catch {
    return false; // an unreadable argv means this file was imported, not run; never start the stdio loop then
  }
})();

if (isMainModule) {
  startStdioLoop();
}
