// The stdio MCP server answers a frame it cannot parse, survives stray values, and exits non-zero with a stack on a crash.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const serverPath = path.resolve('dist/mcp/server.js');
let tmpHome: string;
const procs: ChildProcessWithoutNullStreams[] = [];

interface Run {
  proc: ChildProcessWithoutNullStreams;
  nextLine: (timeoutMs: number) => Promise<string>;
  stderr: () => string;
  exited: Promise<number | null>;
}

function start(args: string[]): Run {
  const proc = spawn(process.execPath, args, {
    cwd: tmpHome,
    env: { ...process.env, HIPPO_HOME: path.join(tmpHome, '.hippo') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(proc);
  const lines: string[] = [];
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
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => proc.once('exit', (code) => resolve(code)));
  const nextLine = (timeoutMs: number): Promise<string> => new Promise((resolve, reject) => {
    const cached = lines.shift();
    if (cached) return resolve(cached);
    const timer = setTimeout(() => reject(new Error(`no reply in ${timeoutMs} ms`)), timeoutMs);
    waiters.push((line) => { clearTimeout(timer); resolve(line); });
  });
  return { proc, nextLine, stderr: () => err, exited };
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

    run.proc.stdin.write('null\n[1,2]\n{"jsonrpc":"2.0","id":2,"method":7}\n');
    run.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    const list = JSON.parse(await run.nextLine(5000));
    expect(list.id).toBe(3);
    expect(run.proc.exitCode).toBeNull();
  }, 15000);

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
