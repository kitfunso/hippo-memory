// Long-running verbs: `hippo dashboard`, `hippo mcp` and `hippo serve`.

import { randomBytes } from 'node:crypto';
import { installCrashHandlers } from '../../base/util/crash-handlers.js';
import { printDashboardBanner, reportListenFailure } from './dashboard-banner.js';
import { envBodyTimeoutMs, envPort, envTlsCert, envTlsKey } from '../../base/util/env.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type CommandContext,
  boolFlag,
  numberFlag,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { fail } from './exit.js';
import { cliStdioHost } from './api-context.js';
import {
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from '../server/defaults.js';
import type { DashboardHandle } from '../server/dashboard-listener.js';
import { localKeyPath } from '../server/local-key.js';

export async function handleDashboard({
  hippoRoot,
  tenantId,
  flags,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);
  const port = numberFlag(flags, 'port') ?? DEFAULT_DASHBOARD_PORT;
  const { DashboardListenError, serveDashboard } = await import('../server/dashboard-listener.js');
  const { builtStaticRoot } = await import('../dashboard/static-file.js');
  const token = randomBytes(32).toString('base64url');
  const opts = {
    hippoRoot,
    tenantId,
    port,
    token,
    handleSignals: true,
    bodyDeadlineMs: envBodyTimeoutMs(),
  };
  let dashboard: DashboardHandle;
  try {
    dashboard = await serveDashboard(opts);
  } catch (err) {
    if (!(err instanceof DashboardListenError) || !(err.cause instanceof Error)) throw err;
    reportListenFailure(port, err.cause);
    return;
  }
  printDashboardBanner({
    hippoRoot,
    port: dashboard.port,
    ticket: dashboard.ticket(),
    staticRoot: builtStaticRoot(),
  });
  // A later throw ends in one log line and exit 1, as it does for serve and mcp.
  installCrashHandlers('dashboard');
  await new Promise(() => {}); // run until Ctrl+C
}

export async function handleMcp(): Promise<void> {
  // Start MCP server over stdio. Dynamic import keeps main CLI lean; the dispatcher itself is
  // transport-agnostic, so we explicitly attach the stdio loop here. (HTTP/SSE transport is wired
  // in src/server.ts and imports the same module without triggering stdin handlers.)
  const mod = await import('../mcp/server.js');
  mod.startStdioLoop(cliStdioHost());
  // Server runs until stdin closes, so we never reach here
  await new Promise(() => {}); // hang forever
}

/** The certificate and key for HTTPS, from --tls-cert and --tls-key or HIPPO_TLS_CERT and
 * HIPPO_TLS_KEY; undefined when neither is set. */
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

/** Said at every start, so the key rule is a choice an operator sees, and an upgrade that
 * changed it explains itself. */
function keyRuleLine(hippoRoot: string): string {
  return (
    'every request needs an API key: the hippo CLI here sends HIPPO_API_KEY, else the member key in ' +
    `${localKeyPath(hippoRoot)} (readable by this user only); mint others with \`hippo auth create\``
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
  const allowCleartext = boolFlag(flags, 'allow-cleartext') || undefined;
  const handle = await serve({ hippoRoot, port, host, handleSignals: true, tls, allowCleartext });
  console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
  console.log(keyRuleLine(hippoRoot));
  console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
  console.log('press Ctrl+C to stop');
  // The SIGINT/SIGTERM handlers stop the server and exit. Hang until then.
  await new Promise(() => {});
}
