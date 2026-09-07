import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember } from '../src/api.js';
import { classifyTransportFailure, HttpResponseError } from '../src/client.js';

// A server that commits the row then drops the socket looks identical to a
// refused connection through `isConnectionRefused`, so the CLI used to self-heal
// its pidfile and write the same memory a second time on the direct path.

const REPO_ROOT = join(import.meta.dirname, '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

function assertFreshBuild(): void {
  const dist = statSync(CLI_PATH).mtimeMs;
  for (const name of ['cli.ts', 'client.ts']) {
    const src = statSync(join(REPO_ROOT, 'src', name)).mtimeMs;
    if (src > dist) {
      throw new Error(`dist/cli.js is older than src/${name}. Run \`npm run build\`; this test spawns the CLI from dist, so a stale build would test old code.`);
    }
  }
}

async function pickFreePort(): Promise<number> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 30000 + Math.floor(Math.random() * 30000);
    try {
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
      return port;
    } catch { /* taken */ }
  }
  throw new Error('could not find a free port after 8 attempts');
}

/**
 * Answers /health so detectServer accepts the pidfile, then commits a real row
 * for POST /v1/memories and destroys the socket instead of replying.
 */
function startResettingServer(hippoRoot: string, port: number, startedAt: string): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ started_at: startedAt }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/memories') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        remember(
          { hippoRoot, tenantId: 'default', actor: { subject: 'stub', role: 'admin' } },
          { content: body.content },
        );
        res.socket?.destroy();
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function runCli(cwd: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

function countMemories(hippoRoot: string, content: string): number {
  const db = openHippoDb(hippoRoot);
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE content = ?').get(content) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

function fetchError(code?: string, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  if (code !== undefined) (err as Error & { cause: unknown }).cause = { code };
  return err;
}

describe('classifyTransportFailure', () => {
  it('calls connect-phase failures safe to replay', () => {
    expect(classifyTransportFailure(fetchError('ECONNREFUSED'))).toBe('never-sent');
    expect(classifyTransportFailure(fetchError('ENOTFOUND'))).toBe('never-sent');
    expect(classifyTransportFailure(new Error('connect ECONNREFUSED 127.0.0.1:9'))).toBe('never-sent');
  });

  it('calls a socket that broke mid-request unsafe to replay', () => {
    // What Node's fetch actually reports when a server destroys the socket
    // before replying, measured 2026-09-07; ECONNRESET is the raw-socket shape.
    expect(classifyTransportFailure(fetchError('UND_ERR_SOCKET'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(fetchError('ECONNRESET'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(fetchError('EPIPE'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(new Error('socket hang up'))).toBe('delivery-unknown');
    // No syscall code to go on, so the conservative answer is the only safe one.
    expect(classifyTransportFailure(fetchError(undefined))).toBe('delivery-unknown');
  });

  it('calls a server response no transport failure at all', () => {
    expect(classifyTransportFailure(new HttpResponseError('not found: mem_ECONNREFUSED', 404))).toBe('none');
    expect(classifyTransportFailure(new Error('something else went wrong'))).toBe('none');
    expect(classifyTransportFailure('not an error')).toBe('none');
  });
});

describe('remember over HTTP when the socket resets after the commit', () => {
  it('does not replay the write on the direct path', async () => {
    assertFreshBuild();
    const home = mkdtempSync(join(tmpdir(), 'hippo-reset-'));
    const hippoRoot = join(home, '.hippo');
    mkdirSync(hippoRoot, { recursive: true });
    initStore(hippoRoot);

    const port = await pickFreePort();
    const startedAt = new Date().toISOString();
    const server = await startResettingServer(hippoRoot, port, startedAt);
    writeFileSync(
      join(hippoRoot, 'server.pid'),
      JSON.stringify({ schema: 1, pid: process.pid, port, url: `http://127.0.0.1:${port}`, started_at: startedAt }),
    );

    // Spawned, not exec'd: execFileSync blocks this process's event loop, so the
    // stub server could not answer the /health probe and the CLI never routed.
    const content = 'the socket died after the server committed this row';
    const { status, stderr } = await runCli(home, ['remember', content]);

    try {
      expect(countMemories(hippoRoot, content)).toBe(1);
      expect(status).not.toBe(0);
      expect(stderr).toContain('may already have been applied');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
