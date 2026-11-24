#!/usr/bin/env node
/**
 * Hippo Memory MCP server: exposes hippo memory as MCP tools over stdio via the programmatic API
 * (no child process). Usage: hippo mcp (or npx hippo-memory mcp). */

export {
  findHippoRoot,
  mcpErrorResponse,
  type McpRequest,
  type McpResponse,
  type McpContext,
} from './protocol.js';
export { handleMcpRequest } from './request.js';
export { startStdioLoop } from './stdio.js';
import { envMcpStdio } from '../../base/util/env.js';
import { startStdioLoop } from './stdio.js';

const isMainModule = (() => {
  const argv1 = process.argv[1] ?? '';
  if (argv1.endsWith('mcp/server.js') || argv1.endsWith('mcp\\server.js')) return true;
  if (envMcpStdio()) return true;
  const mainUrl = `file://${argv1.replace(/\\/g, '/')}`;
  return import.meta.url === mainUrl || import.meta.url === `file:///${argv1.replace(/\\/g, '/')}`;
})();

if (isMainModule) {
  const { cliStdioHost } = await import('../cli/api-context.js');
  const { runCliCommand } = await import('../cli/cli-runtime.js');
  await runCliCommand(() => {
    startStdioLoop(cliStdioHost());
    return new Promise<never>(() => {});
  });
}
