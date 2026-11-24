import { randomBytes } from 'node:crypto';
import { installCrashHandlers } from '../../base/util/crash-handlers.js';
import { printDashboardBanner, reportListenFailure } from './dashboard-banner.js';
import {
  envBodyTimeoutMs,
  envPort,
  envReadOnly,
  envTlsCert,
  envTlsKey,
} from '../../base/util/env.js';
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
  installCrashHandlers('dashboard');
  await new Promise(() => {});
}

export async function handleMcp(): Promise<void> {
  const mod = await import('../mcp/server.js');
  mod.startStdioLoop(cliStdioHost());
  await new Promise(() => {});
}

function readTlsFiles(flags: CommandContext['flags']): { cert: Buffer; key: Buffer } | undefined {
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

function keyRuleLine(hippoRoot: string): string {
  return (
    'every request needs an API key: the hippo CLI here sends HIPPO_API_KEY, else the member key in ' +
    `${localKeyPath(hippoRoot)} (readable by this user only); mint others with \`hippo auth create\``
  );
}

export async function handleServe({ hippoRoot, flags }: CommandContext): Promise<void> {
  if (envReadOnly()) fail('hippo serve does not run under HIPPO_READ_ONLY=1; read with hippo mcp');
  requireInit(hippoRoot);
  const portRaw = stringFlag(flags, 'port') ?? envPort() ?? DEFAULT_SERVER_PORT;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port < 0) {
    fail(`Invalid --port: ${String(portRaw)}`);
  }
  const host = stringFlag(flags, 'host') ?? DEFAULT_SERVER_HOST;
  const tls = readTlsFiles(flags);
  const { serve } = await import('../../server.js');
  const allowCleartext = boolFlag(flags, 'allow-cleartext') || undefined;
  const handle = await serve({ hippoRoot, port, host, handleSignals: true, tls, allowCleartext });
  console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
  console.log(keyRuleLine(hippoRoot));
  console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
  console.log('press Ctrl+C to stop');
  await new Promise(() => {});
}
