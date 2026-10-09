// The stdio MCP server answers a frame it cannot parse, survives stray values, answers a call that outlives its deadline, and exits non-zero with a stack on a crash.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedAll } from '../src/store/embeddings/index.js';

const serverPath = path.resolve('dist/mcp/server.js');
let tmpHome: string;
const procs: ChildProcessWithoutNullStreams[] = [];

interface Run {
  proc: ChildProcessWithoutNullStreams;
  nextLine: (timeoutMs: number) => Promise<string>;
  /** Every line written to stdout so far, read or not. */
  replies: () => readonly string[];
  stderr: () => string;
  exited: Promise<number | null>;
}

function start(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const proc = spawn(process.execPath, args, {
    cwd: tmpHome,
    env: { ...process.env, HIPPO_HOME: path.join(tmpHome, '.hippo'), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(proc);
  const lines: string[] = [];
  const written: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let out = '';
  let err = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
    let idx;
    while ((idx = out.indexOf('\n')) !== -1) {
      const line = out.slice(0, idx).trim();
      out = out.slice(idx + 1);
      if (!line) continue;
      written.push(line);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  // 'close' fires after stdio drains; 'exit' can beat the last stderr chunk.
  const exited = new Promise<number | null>((resolve) => proc.once('close', (code) => resolve(code)));
  const nextLine = (timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
    const cached = lines.shift();
    if (cached) return resolve(cached);
    const timer = setTimeout(() => reject(new Error(`no reply in ${timeoutMs} ms`)), timeoutMs);
    waiters.push((line) => { clearTimeout(timer); resolve(line); });
  });
  return { proc, nextLine, replies: () => written, stderr: () => err, exited };
}

const toolCall = (id: number | undefined, name: string, args: Record<string, string>): string =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`;

/** An embedding endpoint for the store under `tmpHome`: it answers at once until `hold()`, then keeps every request open until `release()`. */
async function heldEmbeddings() {
  let holding = false;
  let asked!: () => void;
  const queryAsked = new Promise<void>((ok) => { asked = ok; });
  const held: Array<() => void> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // SAFETY: the openai provider posts {model, input: string[]} here.
      const { input } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] };
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: input.map(() => ({ embedding: [1, 0, 0] })) }));
      };
      if (!holding) return reply();
      held.push(reply);
      asked();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  // SAFETY: a server listening on TCP reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  const store = path.join(tmpHome, '.hippo');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'config.json'), JSON.stringify({ embeddings: { provider: 'openai', apiBaseUrl: `http://127.0.0.1:${port}` } }));
  vi.stubEnv('OPENAI_API_KEY', 'test-key-not-secret');
  return {
    store,
    /** Settles once a held request has arrived, so the call that sent it is running. */
    queryAsked,
    hold: (): void => { holding = true; },
    release: (): void => { for (const reply of held.splice(0)) reply(); },
    close: (): void => {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** A script that wires the real stdio loop, then fails in the way `failure` names. */
function crashScript(failure: string): string {
  const file = path.join(tmpHome, `crash-${procs.length}.mjs`);
  fs.writeFileSync(file, [
    `const { startStdioLoop } = await import(${JSON.stringify(pathToFileURL(serverPath).href)});`,
    'startStdioLoop();',
    `setTimeout(() => { ${failure} }, 50);`,
  ].join('\n'));
  return file;
}

function exitWithin(run: Run, ms: number): Promise<number | null | 'still running'> {
  return Promise.race([run.exited, new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), ms))]);
}

beforeAll(() => {
  if (!fs.existsSync(serverPath)) throw new Error(`Build first: ${serverPath} missing`);
});

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-faults-'));
});

afterEach(async () => {
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null) {
      // Closing stdin lets the server exit itself and write its coverage; SIGKILL is the fallback.
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('MCP stdio fault handling', () => {
  it('answers malformed JSON with a -32700 parse error and keeps serving', async () => {
    const run = start([serverPath]);
    run.proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":\n');
    const reply = JSON.parse(await run.nextLine(5000));
    expect(reply).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });

    run.proc.stdin.write('null\n[1,2]\n');
    run.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    const list = JSON.parse(await run.nextLine(5000));
    expect(list.id).toBe(3);
    expect(run.proc.exitCode).toBeNull();
  }, 15000);

  it('answers a frame that has an id and no string method with -32600, and only logs one that has neither', async () => {
    const run = start([serverPath]);
    run.proc.stdin.write('{"jsonrpc":"2.0","id":2,"method":7}\n{"jsonrpc":"2.0","id":"abc","result":{}}\n');
    const invalid = { code: -32600, message: 'Invalid Request: method must be a string' };
    expect(JSON.parse(await run.nextLine(5000))).toEqual({ jsonrpc: '2.0', id: 2, error: invalid });
    expect(JSON.parse(await run.nextLine(5000))).toEqual({ jsonrpc: '2.0', id: 'abc', error: invalid });

    // No id means a notification, which may not be answered: the next line out is the reply to the frame after it.
    run.proc.stdin.write('{"jsonrpc":"2.0","params":{}}\n');
    run.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    expect(JSON.parse(await run.nextLine(5000)).id).toBe(3);
    // stderr is a second pipe with no ordering against stdout, so the warning can land after the reply.
    const droppedLines = (): string[] => run.stderr().split('\n').filter((l) => l.includes('dropped a frame with no method and no id'));
    await vi.waitFor(() => expect(droppedLines()).toHaveLength(1), { timeout: 5000 });
    const dropped = droppedLines();
    expect(dropped[0]).toMatch(/^\[hippo\] warn: mcp: dropped a frame with no method and no id/);
    expect(run.proc.exitCode).toBeNull();
  }, 15000);

  it('sends the reply of a call still running when stdin closes, then exits 0', async () => {
    // The endpoint answers at once while the store is seeded, then holds the recall's query embedding until the test has closed stdin.
    const embeddings = await heldEmbeddings();
    try {
      const run = start([serverPath]);
      run.proc.stdin.write(toolCall(1, 'hippo_remember', { text: 'the staging queue drains at midnight' }));
      expect(JSON.parse(await run.nextLine(10000)).id).toBe(1);
      // Recall embeds its query only when the store holds a vector to compare it with.
      expect(await embedAll(embeddings.store)).toBe(1);
      embeddings.hold();
      run.proc.stdin.write(toolCall(9, 'hippo_recall', { query: 'staging queue' }));
      await embeddings.queryAsked;
      run.proc.stdin.end();
      // The child has read the end of stdin once its event loop turns, which this wait outlasts.
      await new Promise((ok) => setTimeout(ok, 300));
      expect(run.proc.exitCode).toBeNull();
      embeddings.release();
      const reply = JSON.parse(await run.nextLine(10000));
      expect(reply.id).toBe(9);
      expect(reply.result.content[0].text).toContain('the staging queue drains at midnight');
      expect(await run.exited).toBe(0);
    } finally {
      embeddings.close();
    }
  }, 30000);

  describe('a call still running at its request deadline', () => {
    const list = (id: number): string => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;

    /** A server on a 1500 ms deadline over a store with one embedded memory, where every later embedding request is held. */
    async function startOnShortDeadline(embeddings: Awaited<ReturnType<typeof heldEmbeddings>>): Promise<Run> {
      // Seeded by a server on the default deadline, so only a held recall can reach the short one.
      const seed = start([serverPath]);
      seed.proc.stdin.write(toolCall(1, 'hippo_remember', { text: 'the staging queue drains at midnight' }));
      expect(JSON.parse(await seed.nextLine(10000)).id).toBe(1);
      seed.proc.stdin.end();
      expect(await seed.exited).toBe(0);
      expect(await embedAll(embeddings.store)).toBe(1);
      embeddings.hold();
      return start([serverPath], { HIPPO_REQUEST_DEADLINE_MS: '1500' });
    }

    const timeoutLines = (run: Run): string[] => run.stderr().split('\n').filter((l) => l.includes('did not answer within 1500 ms'));

    /** Lets the held recall finish, then closes stdin, whose drain waits for it: a late reply would be on stdout before the exit. */
    async function repliesAfterTheLateFinish(embeddings: Awaited<ReturnType<typeof heldEmbeddings>>, run: Run): Promise<unknown[]> {
      embeddings.release();
      run.proc.stdin.end();
      expect(await run.exited).toBe(0);
      return run.replies().map((line) => JSON.parse(line).id);
    }

    it('gets one timeout error with its id, the late reply is dropped, and the next call is answered', async () => {
      const embeddings = await heldEmbeddings();
      try {
        const run = await startOnShortDeadline(embeddings);
        run.proc.stdin.write(toolCall(9, 'hippo_recall', { query: 'staging queue' }));
        expect(JSON.parse(await run.nextLine(15000))).toEqual({
          jsonrpc: '2.0',
          id: 9,
          error: {
            code: -32001,
            message: 'Request timed out: tools/call hippo_recall did not finish within 1500 ms; a write it started may or may not be saved',
            data: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
          },
        });
        // stderr is a second pipe with no ordering against stdout, so the warning can land after the reply.
        await vi.waitFor(() => expect(timeoutLines(run)).toHaveLength(1), { timeout: 5000 });
        expect(timeoutLines(run)[0]).toMatch(/^\[hippo\] warn: mcp: tools\/call hippo_recall did not answer within 1500 ms; .* method=tools\/call/);

        run.proc.stdin.write(list(10));
        expect(JSON.parse(await run.nextLine(5000)).id).toBe(10);
        expect(await repliesAfterTheLateFinish(embeddings, run)).toEqual([9, 10]);
      } finally {
        embeddings.close();
      }
    }, 45000);

    it('is only logged when it has no id, since a notification is never answered', async () => {
      const embeddings = await heldEmbeddings();
      try {
        const run = await startOnShortDeadline(embeddings);
        run.proc.stdin.write(toolCall(undefined, 'hippo_recall', { query: 'staging queue' }));
        await vi.waitFor(() => expect(timeoutLines(run)).toHaveLength(1), { timeout: 15000 });

        // The first line out is the reply to the call sent after the deadline passed.
        run.proc.stdin.write(list(10));
        expect(JSON.parse(await run.nextLine(5000)).id).toBe(10);
        expect(await repliesAfterTheLateFinish(embeddings, run)).toEqual([10]);
      } finally {
        embeddings.close();
      }
    }, 45000);
  });

  it('refuses a frame over 1 MB with a parse error, buffers none of it, and keeps serving', async () => {
    const run = start([serverPath]);
    const list = (id: number): string => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`;
    const refusal = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: frame exceeds 1MB' } };

    // A declared length over the cap is refused at the header; its body is dropped as it arrives, so the next frame is read as itself.
    const declared = 2 * 1024 * 1024;
    run.proc.stdin.write(`Content-Length: ${declared}\r\n\r\n`);
    expect(JSON.parse(await run.nextLine(5000))).toEqual(refusal);
    run.proc.stdin.write(Buffer.alloc(declared, 0x78));
    run.proc.stdin.write(list(1));
    expect(JSON.parse(await run.nextLine(10000)).id).toBe(1);

    // A line that never ends is refused once it passes the cap; the frame after its newline still answers.
    run.proc.stdin.write(Buffer.alloc(1024 * 1024 + 64 * 1024, 0x79));
    expect(JSON.parse(await run.nextLine(10000))).toEqual(refusal);
    run.proc.stdin.write(`yyy\n${list(2)}`);
    expect(JSON.parse(await run.nextLine(10000)).id).toBe(2);
    expect(run.proc.exitCode).toBeNull();
  }, 40000);

  it('exits non-zero and logs the stack on an uncaught exception', async () => {
    const run = start([crashScript("throw new Error('boom-uncaught');")]);
    const code = await exitWithin(run, 8000);
    expect(code).toBe(1);
    expect(run.stderr()).toMatch(/mcp uncaught exception: boom-uncaught .*errorClass=Error stack=Error: boom-uncaught\s+at /);
  }, 15000);

  it('exits non-zero and logs the stack on an unhandled rejection', async () => {
    const run = start([crashScript("Promise.reject(new TypeError('boom-rejected'));")]);
    const code = await exitWithin(run, 8000);
    expect(code).toBe(1);
    expect(run.stderr()).toMatch(/mcp unhandled rejection: boom-rejected .*errorClass=TypeError stack=TypeError: boom-rejected\s+at /);
  }, 15000);
});
