// Long-running verbs: `hippo dashboard`, `hippo mcp` and `hippo serve`.

import { installCrashHandlers } from '../util/crash-handlers.js';
import { envAllowKeylessLocal, envPort, envRequireAuth, envTlsCert, envTlsKey } from '../util/env.js';
import * as fs from 'fs';
import * as path from 'path';
import { printError } from './output.js';
import { stringFlagOrExit, type CommandContext, stringFlag } from './flag-values.js';
import { requireInit } from './shared.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

export async function handleDashboard({ hippoRoot, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const port = parseInt(String(flags['port'] ?? '3333'), 10);
  const { serveDashboard } = await import('../dashboard/dashboard.js');
  serveDashboard(hippoRoot, port, undefined, { handleSignals: true });
  // A later throw ends in one log line and exit 1, as it does for serve and mcp; a busy port is reported by the dashboard itself.
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

/** The certificate and key for HTTPS, from --tls-cert and --tls-key or HIPPO_TLS_CERT and HIPPO_TLS_KEY; undefined when neither is set. */
function readTlsFiles(flags: CommandContext['flags']): { cert: Buffer; key: Buffer } | undefined {
  // A flag with no value exits here; falling back to cleartext would hide the mistake.
  const certPath = stringFlagOrExit(flags, 'tls-cert') ?? envTlsCert();
  const keyPath = stringFlagOrExit(flags, 'tls-key') ?? envTlsKey();
  if (certPath === undefined && keyPath === undefined) return undefined;
  if (certPath === undefined || keyPath === undefined) {
    printError('hippo serve: TLS needs both a certificate and a key: --tls-cert and --tls-key, or HIPPO_TLS_CERT and HIPPO_TLS_KEY.');
    throw new CliExit(1);
  }
  try {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (err) {
    printError(`hippo serve: cannot read the TLS files: ${errorMessage(err)}`);
    throw new CliExit(1);
  }
}

/** Said at every start, so the key rule is a choice an operator sees, and an upgrade that changed it explains itself. */
function keyRuleLine(): string {
  if (envRequireAuth()) return 'every request needs an API key (HIPPO_REQUIRE_AUTH=1)';
  if (envAllowKeylessLocal()) {
    return 'requests from this machine need no API key and act as host admin (HIPPO_ALLOW_KEYLESS_LOCAL=1); unset it to require a key on every request';
  }
  return 'every request needs an API key: mint one with `hippo auth create` and send it as "Authorization: Bearer <key>" ' +
    '(the hippo CLI reads HIPPO_API_KEY). To let requests from this machine in without a key, start with HIPPO_ALLOW_KEYLESS_LOCAL=1';
}

export async function handleServe({ hippoRoot, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const portRaw = flags['port'] ?? envPort() ?? '6789';
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 0) {
    printError(`Invalid --port: ${String(portRaw)}`);
    throw new CliExit(1);
  }
  const host = stringFlag(flags, 'host') ?? '127.0.0.1';
  const tls = readTlsFiles(flags);
  const { serve } = await import('../server.js');
  const handle = await serve({ hippoRoot, port, host, handleSignals: true, tls });
  console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
  console.log(keyRuleLine());
  console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
  console.log('press Ctrl+C to stop');
  // The SIGINT/SIGTERM handlers stop the server and exit. Hang until then.
  await new Promise(() => {});
}
