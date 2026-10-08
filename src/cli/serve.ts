// Long-running verbs: `hippo dashboard`, `hippo mcp` and `hippo serve`.

import { installCrashHandlers } from '../util/crash-handlers.js';
import { envPort } from '../env.js';
import * as path from 'path';
import { printError } from './output.js';
import { requireInit, type CommandContext } from './shared.js';

export async function handleDashboard({ hippoRoot, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const port = parseInt(String(flags['port'] ?? '3333'), 10);
  const { serveDashboard } = await import('../dashboard.js');
  serveDashboard(hippoRoot, port);
  // A busy port or a later throw ends in one log line and exit 1, as it does for serve and mcp.
  installCrashHandlers('dashboard');
  await new Promise(() => {}); // run until Ctrl+C
}

export async function handleMcp(): Promise<void> {
  // Start MCP server over stdio. Dynamic import keeps main CLI lean; the
  // dispatcher itself is transport-agnostic, so we explicitly attach the
  // stdio loop here. (HTTP/SSE transport is wired in src/server.ts and
  // imports the same module without triggering stdin handlers.)
  const mod = await import('../mcp/server.js');
  mod.startStdioLoop();
  // Server runs until stdin closes, so we never reach here
  await new Promise(() => {}); // hang forever
}

export async function handleServe({ hippoRoot, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const portRaw = flags['port'] ?? envPort() ?? '6789';
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 0) {
    printError(`Invalid --port: ${String(portRaw)}`);
    process.exit(1);
  }
  const host = typeof flags['host'] === 'string' ? (flags['host'] as string) : '127.0.0.1';
  const { serve } = await import('../server.js');
  const handle = await serve({ hippoRoot, port, host, handleSignals: true });
  console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
  console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
  console.log('press Ctrl+C to stop');
  // The SIGINT/SIGTERM handlers stop the server and exit. Hang until then.
  await new Promise(() => {});
}
