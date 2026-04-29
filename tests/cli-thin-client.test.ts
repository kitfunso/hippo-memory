import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';

/**
 * Headline parity test for A1: when `hippo serve` is running, CLI invocations
 * route through HTTP; when it's gone (or stale pidfile), they fall back to
 * direct DB access. We assert by reading the audit log: HTTP path stamps
 * actor='localhost:cli', direct path stamps actor='cli'.
 */

const REPO_ROOT = join(__dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

function makeWorkspace(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-thin-'));
  const hippoRoot = join(home, '.hippo');
  mkdirSync(hippoRoot, { recursive: true });
  initStore(hippoRoot);
  return home;
}

/**
 * Pick a random high port and verify it's actually free by trying to bind a
 * throwaway server. Retries a handful of times before giving up.
 */
async function pickFreePort(): Promise<number> {
  const { createServer } = await import('node:http');
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 30000);
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => {
          probe.close(() => resolve());
        });
      });
      return port;
    } catch {
      // taken; try another
    }
  }
  throw new Error('could not find a free port after 8 attempts');
}

interface SpawnedServer {
  child: ChildProcessWithoutNullStreams;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

async function startServer(workspace: string, port: number): Promise<SpawnedServer> {
  const child = spawn(process.execPath, [CLI_PATH, 'serve', '--port', String(port)], {
    cwd: workspace,
    env: { ...process.env, HIPPO_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

  // Wait for the pidfile to appear AND /health to respond. The pidfile-only
  // gate is racy because writePidfile fires synchronously before the listen
  // ack returns to userland; combine with a real health probe to be safe.
  const pidfilePath = join(workspace, '.hippo', 'server.pid');
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `hippo serve exited early (code=${child.exitCode}). stdout=${stdoutBuf} stderr=${stderrBuf}`,
      );
    }
    if (existsSync(pidfilePath)) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) { ready = true; break; }
      } catch { /* server not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`server did not become ready within 10s. stdout=${stdoutBuf} stderr=${stderrBuf}`);
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    // Windows doesn't actually deliver SIGTERM; fall back to SIGKILL after a beat.
    const stopDeadline = Date.now() + 3_000;
    while (Date.now() < stopDeadline && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (child.exitCode === null) child.kill('SIGKILL');
    // Wait for the pidfile to be cleared OR for the process to be gone, then
    // best-effort wipe so the next spawn starts clean.
    const wipeDeadline = Date.now() + 2_000;
    while (Date.now() < wipeDeadline && existsSync(pidfilePath)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (existsSync(pidfilePath)) {
      try { rmSync(pidfilePath); } catch { /* ignore */ }
    }
  };

  return { child, port, url: `http://127.0.0.1:${port}`, stop };
}

function runCli(workspace: string, ...cliArgs: string[]): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...cliArgs], {
      cwd: workspace,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '' };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: typeof err.stdout === 'string' ? err.stdout : (err.stdout?.toString('utf8') ?? ''),
      stderr: typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? ''),
    };
  }
}

function getActorForContent(workspace: string, contentNeedle: string): string | null {
  const db = openHippoDb(join(workspace, '.hippo'));
  try {
    const events = queryAuditEvents(db, { tenantId: 'default', op: 'remember', limit: 200 });
    for (const ev of events) {
      const meta = ev.metadata ?? {};
      const target = ev.targetId;
      if (!target) continue;
      // Check whether this audit row corresponds to a memory whose content
      // contains our needle. We look it up via the memories table directly
      // since api/store don't expose a content lookup helper here.
      const row = db.prepare(`SELECT content FROM memories WHERE id = ?`).get(target) as
        | { content: string }
        | undefined;
      if (row && row.content.includes(contentNeedle)) {
        return ev.actor;
      }
    }
    return null;
  } finally {
    closeHippoDb(db);
  }
}

describe('cli thin-client mode', () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
    if (!statSync(CLI_PATH).isFile()) {
      throw new Error(`${CLI_PATH} is not a file`);
    }
  });

  it('routes through HTTP when server is up, falls back to direct when stopped', async () => {
    const workspace = makeWorkspace();
    let server: SpawnedServer | null = null;
    try {
      const port = await pickFreePort();
      server = await startServer(workspace, port);

      // Run remember through the spawned CLI. With pidfile present, this must
      // route over HTTP and audit with actor='localhost:cli'.
      const httpRun = runCli(workspace, 'remember', 'thin-client-canary-99');
      expect(httpRun.stdout, `stderr: ${httpRun.stderr}`).toMatch(/Remembered/);

      const httpActor = getActorForContent(workspace, 'thin-client-canary-99');
      expect(httpActor).toBe('localhost:cli');

      // Stop server. Pidfile must be gone.
      await server.stop();
      server = null;
      const pidfilePath = join(workspace, '.hippo', 'server.pid');
      expect(existsSync(pidfilePath)).toBe(false);

      // Without server, remember must take the direct path (actor='cli').
      const directRun = runCli(workspace, 'remember', 'fallback-canary-88');
      expect(directRun.stdout, `stderr: ${directRun.stderr}`).toMatch(/Remembered/);
      const directActor = getActorForContent(workspace, 'fallback-canary-88');
      expect(directActor).toBe('cli');
    } finally {
      if (server) await server.stop();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);

  it('self-heals on a stale pidfile', async () => {
    const workspace = makeWorkspace();
    try {
      // Forge a pidfile pointing at a definitely-dead pid. detectServer probes
      // via signal 0 — if we're unlucky this PID happens to belong to a live
      // process, in which case the test would route HTTP to a random listener.
      // Mitigate by also pointing at a port nothing's bound to: the
      // connection-refused fallback in client.ts then takes over.
      const stalePid = 99_999_999;
      const stalePort = 31_111; // arbitrary; any real listener would be coincidental
      const pidfilePath = join(workspace, '.hippo', 'server.pid');
      writeFileSync(pidfilePath, JSON.stringify({
        pid: stalePid,
        port: stalePort,
        url: `http://127.0.0.1:${stalePort}`,
        started_at: new Date().toISOString(),
      }));

      const run = runCli(workspace, 'remember', 'stale-pidfile-canary-77');
      expect(run.stdout + run.stderr).toMatch(/Remembered|stale|fallback/i);

      // Pidfile should have been cleaned up by detectServer (dead pid) or by
      // the stale-fallback handler (if the pid happened to be alive).
      expect(existsSync(pidfilePath)).toBe(false);

      // Memory landed via direct path → audit actor='cli'.
      const actor = getActorForContent(workspace, 'stale-pidfile-canary-77');
      expect(actor).toBe('cli');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 15_000);
});
