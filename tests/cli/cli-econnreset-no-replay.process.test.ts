import { describe, it, expect } from 'vitest';
import { existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { remember } from '../../src/api/index.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import {
  classifyTransportFailure,
  deliveryUnknownReason,
  HttpResponseError,
  MalformedReplyError,
  postRemember,
} from '../../src/surface/cli/client.js';
import { boundPort } from '../_helpers/listen.js';
import { ROUTED_CLI_ENV } from '../_helpers/routed-cli-env.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeStore } from '../_helpers/make-root.js';
import { seedRows } from '../_helpers/seed-rows.js';

// A server that commits the row then drops the socket looks identical to a
// refused connection through `isConnectionRefused`, so the CLI used to self-heal
// its pidfile and write the same memory a second time on the direct path.

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

function assertFreshBuild(): void {
  const dist = statSync(CLI_PATH).mtimeMs;
  for (const name of ['cli.ts', 'surface/cli/client.ts', 'surface/server/server-detect.ts']) {
    const src = statSync(join(REPO_ROOT, 'src', name)).mtimeMs;
    if (src > dist) {
      throw new Error(
        `dist/cli.js is older than src/${name}. Run \`npm run build\`; this test spawns the CLI from dist, so a stale build would test old code.`,
      );
    }
  }
}

/** Answers /health so detectServer accepts the pidfile, then commits POST /v1/memories and drops the socket unanswered. */
async function startResettingServer(
  hippoRoot: string,
  startedAt: string,
): Promise<{ server: Server; port: number; posts: { count: number } }> {
  const posts = { count: 0 };
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ started_at: startedAt }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/memories') {
      posts.count++;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await remember(apiCtx(hippoRoot, 'default', { subject: 'stub', role: 'admin' }), { content: body.content });
        res.socket?.destroy();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  return { server, port: await boundPort(server), posts };
}

const WRITE_ROUTES: readonly (readonly [string, RegExp])[] = [
  ['POST', /^\/v1\/memories$/],
  ['DELETE', /^\/v1\/memories\/[^/]+$/],
  ['POST', /^\/v1\/memories\/[^/]+\/(archive|promote)$/],
];

/** Answers /health so detectServer accepts the pidfile, then answers every write route with `status` and `body` and commits nothing. */
async function startReplyServer(
  startedAt: string,
  body: string,
  status = 200,
): Promise<{ server: Server; port: number; writes: { count: number } }> {
  const writes = { count: 0 };
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ started_at: startedAt }));
      return;
    }
    if (!WRITE_ROUTES.some(([method, path]) => req.method === method && path.test(req.url ?? ''))) {
      res.writeHead(404).end();
      return;
    }
    writes.count++;
    req.resume();
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1');
  return { server, port: await boundPort(server), writes };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function writePidfile(hippoRoot: string, port: number, startedAt: string): void {
  writeFileSync(
    join(hippoRoot, 'server.pid'),
    JSON.stringify({ schema: 1, pid: process.pid, port, url: `http://127.0.0.1:${port}`, started_at: startedAt }),
  );
}

function runCli(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, ...ROUTED_CLI_ENV, ...extraEnv };
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('close', (code) => resolve({ status: code ?? -1, stdout, stderr }));
  });
}

function countRows(hippoRoot: string, table: 'memories' | 'raw_archive', column: string, value: string): number {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: an aggregate SELECT returns exactly one row and COUNT(*) is an integer.
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(value) as { n: number };
    return row.n;
  } finally {
    closeHippoDb(db);
  }
}

function countMemories(hippoRoot: string, content: string): number {
  return countRows(hippoRoot, 'memories', 'content', content);
}

function fetchError(code?: string, message = 'fetch failed'): Error {
  const err = new TypeError(message);
  if (code !== undefined) err.cause = { code };
  return err;
}

describe('classifyTransportFailure', () => {
  it('calls connect-phase failures safe to replay', () => {
    expect(classifyTransportFailure(fetchError('ECONNREFUSED'))).toBe('never-sent');
    expect(classifyTransportFailure(fetchError('ENOTFOUND'))).toBe('never-sent');
    expect(classifyTransportFailure(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }))).toBe(
      'never-sent',
    );
  });

  it('calls a socket that broke mid-request unsafe to replay', () => {
    // What Node's fetch actually reports when a server destroys the socket
    // before replying, measured 2026-09-07; ECONNRESET is the raw-socket shape.
    expect(classifyTransportFailure(fetchError('UND_ERR_SOCKET'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(fetchError('ECONNRESET'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(fetchError('EPIPE'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(
      'delivery-unknown',
    );
    // No syscall code to go on, so the conservative answer is the only safe one.
    expect(classifyTransportFailure(fetchError(undefined))).toBe('delivery-unknown');
  });

  it('calls only a server answer or an unbuilt request no transport failure', () => {
    expect(classifyTransportFailure(new HttpResponseError('not found: mem_ECONNREFUSED', 404))).toBe('none');
    // encodeURIComponent throws this before any request exists.
    expect(classifyTransportFailure(new URIError('URI malformed'))).toBe('none');
  });

  it('calls an error of an unlisted class possibly delivered', () => {
    expect(classifyTransportFailure(new Error('something else went wrong'))).toBe('delivery-unknown');
    // Message text alone never classifies: only the error class or syscall code does.
    expect(classifyTransportFailure(new Error('connect ECONNREFUSED 127.0.0.1:9'))).toBe('delivery-unknown');
    expect(classifyTransportFailure(new MalformedReplyError('POST /v1/memories', 'null'))).toBe('delivery-unknown');
  });
});

describe('postRemember when a 2xx reply cannot be read', () => {
  it.each([
    ['is not JSON', 'not json', 200, 'reply is not JSON'],
    ['is over the 1 MiB cap', 'x'.repeat(1024 * 1024 + 1), 200, 'reply over 1048576 bytes'],
    ['is an empty 200', '', 200, 'reply is not JSON'],
    ['is a 204 with no body', '', 204, 'reply has no body'],
  ])(
    'rejects with a MalformedReplyError that keeps the cause when the reply %s',
    async (_name, body, status, cause) => {
      const { server, port } = await startReplyServer(new Date().toISOString(), body, status);
      try {
        const err = await postRemember(`http://127.0.0.1:${port}`, undefined, { content: 'a fact' }).catch(
          (e: Error) => e,
        );
        expect(err).toBeInstanceOf(MalformedReplyError);
        expect(err).toHaveProperty('cause.message', cause);
      } finally {
        await closeServer(server);
      }
    },
  );
});

describe('deliveryUnknownReason', () => {
  const URL = 'http://127.0.0.1:4242';
  const DROPPED = `the connection to ${URL} dropped or timed out mid-request, so the write may already have been applied. Not retrying locally.`;
  const unrecognised = (detail: string): string =>
    `the request to ${URL} failed in a way hippo does not recognise${detail}, so the write may already have been applied. Not retrying locally.`;

  it('says a reply it could not read may belong to a write that landed', () => {
    expect(deliveryUnknownReason(new MalformedReplyError('POST /v1/memories', 'null'), URL)).toBe(
      `${URL} answered, but its reply could not be read, so the write may already have been applied. Not retrying locally.`,
    );
  });

  it('says a connection that dropped or timed out mid-request may belong to a write that landed', () => {
    expect(deliveryUnknownReason(fetchError('ECONNRESET'), URL)).toBe(DROPPED);
    expect(deliveryUnknownReason(fetchError('UND_ERR_SOCKET'), URL)).toBe(DROPPED);
    expect(deliveryUnknownReason(fetchError(undefined), URL)).toBe(DROPPED);
    expect(deliveryUnknownReason(Object.assign(new Error('socket hang up'), { code: 'EPIPE' }), URL)).toBe(DROPPED);
    expect(
      deliveryUnknownReason(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), URL),
    ).toBe(DROPPED);
  });

  it('names the code or class of an error it does not recognise, and a plain Error by nothing', () => {
    expect(deliveryUnknownReason(new Error('boom'), URL)).toBe(unrecognised(''));
    expect(deliveryUnknownReason(new RangeError('boom'), URL)).toBe(unrecognised(' (RangeError)'));
    expect(deliveryUnknownReason(Object.assign(new Error('boom'), { code: 'EHOSTUNREACH' }), URL)).toBe(
      unrecognised(' (EHOSTUNREACH)'),
    );
    // A code that is not a plain syscall name is never echoed.
    expect(deliveryUnknownReason(Object.assign(new Error('boom'), { code: 'bad code!' }), URL)).toBe(unrecognised(''));
  });

  it('never puts the message of a foreign error in the sentence', () => {
    const secret = 'Authorization: Bearer SECRET-KEY';
    const errors = [
      new Error(secret),
      new RangeError(secret),
      fetchError('ECONNRESET', secret),
      fetchError(undefined, secret),
      Object.assign(new Error(secret), { code: 'EHOSTUNREACH' }),
      new DOMException(secret, 'TimeoutError'),
    ];
    for (const err of errors) expect(deliveryUnknownReason(err, URL)).not.toContain('SECRET-KEY');
  });
});

describe('remember over HTTP when the socket resets after the commit', () => {
  it('does not replay the write on the direct path', async () => {
    assertFreshBuild();
    const { base: home, root: hippoRoot } = makeStore('reset');

    const startedAt = new Date().toISOString();
    const { server, port, posts } = await startResettingServer(hippoRoot, startedAt);
    writePidfile(hippoRoot, port, startedAt);

    // Spawned, not exec'd: execFileSync blocks this process's event loop, so the
    // stub server could not answer the /health probe and the CLI never routed.
    const content = 'the socket died after the server committed this row';
    const { status, stderr } = await runCli(home, ['remember', content]);

    try {
      expect(posts.count, `the CLI never routed to the stub server; stderr: ${stderr}`).toBe(1);
      expect(countMemories(hippoRoot, content)).toBe(1);
      expect(status, stderr).toBe(1);
      expect(stderr).toContain('may already have been applied');
      expect(stderr).not.toContain('hippo recall');
    } finally {
      await closeServer(server);
    }
  });
});

interface VerbCase {
  readonly verb: string;
  /** Fields laid over the one local row seeded first; none for a verb that writes its own row. */
  readonly seed?: Partial<MemoryEntry>;
  readonly args: (id: string) => string[];
  /** Asserts the local effect a replay would have had did not happen. */
  readonly untouched: (hippoRoot: string, id: string, globalHome: string) => void;
}

const REMEMBERED = 'a fact whose server reply cannot be read';
const VERB_CASES: readonly VerbCase[] = [
  {
    verb: 'remember',
    args: () => ['remember', REMEMBERED],
    untouched: (hippoRoot) => expect(countMemories(hippoRoot, REMEMBERED)).toBe(0),
  },
  {
    verb: 'forget',
    seed: {},
    args: (id) => ['forget', id],
    untouched: (hippoRoot, id) => expect(countRows(hippoRoot, 'memories', 'id', id)).toBe(1),
  },
  {
    verb: 'archive',
    seed: { kind: 'raw' },
    args: (id) => ['forget', id, '--archive', '--reason', 'test'],
    untouched: (hippoRoot, id) => {
      expect(countRows(hippoRoot, 'memories', 'id', id)).toBe(1);
      expect(countRows(hippoRoot, 'raw_archive', 'memory_id', id)).toBe(0);
    },
  },
  {
    verb: 'promote',
    seed: {},
    args: (id) => ['promote', id],
    untouched: (hippoRoot, id, globalHome) => {
      expect(countRows(hippoRoot, 'memories', 'id', id)).toBe(1);
      // A replay would have created the global store to copy into.
      expect(existsSync(globalHome)).toBe(false);
    },
  },
];

describe('a served write whose 2xx reply cannot be read', () => {
  it.each(VERB_CASES)('$verb is not replayed on the local store', async ({ verb, seed, args, untouched }) => {
    assertFreshBuild();
    const { base: home, root: hippoRoot } = makeStore(`unreadable-${verb}`);
    const id = seed
      ? seedRows(
          hippoRoot,
          1,
          () => `a row the ${verb} verb must leave alone`,
          () => seed,
        )[0].id
      : '';

    const startedAt = new Date().toISOString();
    const { server, port, writes } = await startReplyServer(startedAt, 'not json');
    writePidfile(hippoRoot, port, startedAt);
    const globalHome = join(home, 'global');
    const { status, stderr } = await runCli(home, args(id), { HIPPO_HOME: globalHome });

    try {
      expect(writes.count, `the CLI never routed to the stub server; stderr: ${stderr}`).toBe(1);
      expect(status, stderr).toBe(1);
      expect(stderr).toContain('answered, but its reply could not be read, so the write may already have been applied');
      expect(stderr).not.toContain('hippo recall');
      untouched(hippoRoot, id, globalHome);
    } finally {
      await closeServer(server);
    }
  });
});

describe('remember when the pidfile names a port nothing listens on', () => {
  it('writes on the local store and reports no possibly delivered write', async () => {
    assertFreshBuild();
    const { base: home, root: hippoRoot } = makeStore('dead-port');
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    const port = await boundPort(listener);
    await closeServer(listener);
    writePidfile(hippoRoot, port, new Date().toISOString());

    const content = 'nothing answers at the pidfile port';
    const { status, stderr } = await runCli(home, ['remember', content]);

    expect(status, stderr).toBe(0);
    expect(stderr).not.toContain('may already have been applied');
    expect(countMemories(hippoRoot, content)).toBe(1);
  });
});
