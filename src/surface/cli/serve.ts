// Long-running verbs: `hippo dashboard`, `hippo mcp` and `hippo serve`.

import { randomBytes } from 'crypto';
import { installCrashHandlers } from '../../base/util/crash-handlers.js';
import { printDashboardBanner, reportListenFailure } from './dashboard-banner.js';
import {
  envAllowKeylessLocal,
  envBodyTimeoutMs,
  envPort,
  envRequireAuth,
  envTlsCert,
  envTlsKey,
} from '../../base/util/env.js';
import * as fs from 'fs';
import * as path from 'path';
import { flagIsTrue, stringFlagOrExit, type CommandContext, stringFlag, numberFlag } from './flag-values.js';
import { requireInit } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { fail } from './exit.js';
import { cliStdioHost } from './api-context.js';
import { DEFAULT_DASHBOARD_PORT, DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '../server/defaults.js';

export async function handleDashboard({ hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const port = numberFlag(flags, 'port') ?? DEFAULT_DASHBOARD_PORT;
  const { DashboardListenError, serveDashboard } = await import('../server/dashboard-listener.js');
  const { builtStaticRoot } = await import('../dashboard/static-file.js');
  const token = randomBytes(32).toString('base64url');
  const opts = { hippoRoot, tenantId, port, token, handleSignals: true, bodyDeadlineMs: envBodyTimeoutMs() };
  let bound: number;
  try {
    bound = (await serveDashboard(opts)).port;
  } catch (err) {
    if (!(err instanceof DashboardListenError) || !(err.cause instanceof Error)) throw err;
    reportListenFailure(port, err.cause);
    return;
  }
  printDashboardBanner(hippoRoot, bound, token, builtStaticRoot());
  // A later throw ends in one log line and exit 1, as it does for serve and mcp.
  installCrashHandlers('dashboard');
  await new Promise(() => {}); // run until Ctrl+C
}

export async function handleMcp(): Promise<void> {
  // Start MCP server over stdio. Dynamic import keeps main CLI lean; the dispatcher itself is transport-agnostic, so we
  // explicitly attach the stdio loop here. (HTTP/SSE transport is wired in src/server.ts and imports the same module
  // without triggering stdin handlers.)
  const mod = await import('../mcp/server.js');
  mod.startStdioLoop(cliStdioHost());
  // Server runs until stdin closes, so we never reach here
  await new Promise(() => {}); // hang forever
}

/** The certificate and key for HTTPS, from --tls-cert and --tls-key or HIPPO_TLS_CERT and HIPPO_TLS_KEY; undefined when
 * neither is set. */
function readTlsFiles(flags: CommandContext['flags']): { cert: Buffer; key: Buffer } | undefined {
  // A flag with no value exits here; falling back to cleartext would hide the mistake.
  const certPath = stringFlagOrExit(flags, 'tls-cert') ?? envTlsCert();
  const keyPath = stringFlagOrExit(flags, 'tls-key') ?? envTlsKey();
  if (certPath === undefined && keyPath === undefined) return undefined;
  if (certPath === undefined || keyPath === undefined) {
    fail(
      'hippo serve: TLS needs both a certificate and a key: --tls-cert and --tls-key, ' +
        'or HIPPO_TLS_CERT and HIPPO_TLS_KEY.',
    );
  }
  try {
    return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  } catch (err) {
    fail(`hippo serve: cannot read the TLS files: ${errorMessage(err)}`);
  }
}

/**
 * Said at every start, so the key rule is a choice an operator sees, and an upgrade that changed it explains itself.
 */
function keyRuleLine(): string {
  if (envRequireAuth()) return 'every request needs an API key (HIPPO_REQUIRE_AUTH=1)';
  if (envAllowKeylessLocal()) {
    return (
      'requests from this machine need no API key and act as a member (HIPPO_ALLOW_KEYLESS_LOCAL=1); ' +
      'unset HIPPO_ALLOW_KEYLESS_LOCAL to require a key on every request'
    );
  }
  return (
    'every request needs an API key: mint one with `hippo auth create` and send it as ' +
    '"Authorization: Bearer <key>" ' +
    '(the hippo CLI reads HIPPO_API_KEY). To let requests from this machine in without a key, ' +
    'start with HIPPO_ALLOW_KEYLESS_LOCAL=1'
  );
}

export async function handleServe({ hippoRoot, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const portRaw = stringFlag(flags, 'port') ?? envPort() ?? DEFAULT_SERVER_PORT;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 0) {
    fail(`Invalid --port: ${String(portRaw)}`);
  }
  const host = stringFlag(flags, 'host') ?? DEFAULT_SERVER_HOST;
  const tls = readTlsFiles(flags);
  const { serve } = await import('../../server.js');
  // Unset rather than false without the flag, so HIPPO_ALLOW_CLEARTEXT=1 still applies.
  const allowCleartext = flagIsTrue(flags, 'allow-cleartext') || undefined;
  const handle = await serve({ hippoRoot, port, host, handleSignals: true, tls, allowCleartext });
  console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
  console.log(keyRuleLine());
  console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
  console.log('press Ctrl+C to stop');
  // The SIGINT/SIGTERM handlers stop the server and exit. Hang until then.
  await new Promise(() => {});
}
