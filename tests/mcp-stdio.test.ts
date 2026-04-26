import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseFrame } from '../src/mcp/framing.js';

// ─── parseFrame unit tests ───

describe('parseFrame', () => {
  it('parses newline-delimited JSON (MCP spec)', () => {
    const buf = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    const result = parseFrame(buf);
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(JSON.parse(result.body).method).toBe('ping');
      expect(result.rest.length).toBe(0);
    }
  });

  it('parses Content-Length framing (LSP-style legacy)', () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const buf = Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`);
    const result = parseFrame(buf);
    expect(result.kind).toBe('message');
    if (result.kind === 'message') {
      expect(JSON.parse(result.body).method).toBe('ping');
    }
  });

  it('returns incomplete when no full frame is present', () => {
    expect(parseFrame(Buffer.from('{"jsonrpc":"2.0"')).kind).toBe('incomplete');
    expect(parseFrame(Buffer.from('Content-Length: 50\r\n\r\n{"x"')).kind).toBe('incomplete');
  });

  it('handles back-to-back NDJSON messages', () => {
    const buf = Buffer.from(
      '{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n'
    );
    const first = parseFrame(buf);
    expect(first.kind).toBe('message');
    if (first.kind !== 'message') return;
    expect(JSON.parse(first.body).method).toBe('a');
    const second = parseFrame(first.rest);
    expect(second.kind).toBe('message');
    if (second.kind !== 'message') return;
    expect(JSON.parse(second.body).method).toBe('b');
  });

  it('skips leading blank lines between messages', () => {
    const buf = Buffer.from('\n\n{"jsonrpc":"2.0","id":1,"method":"x"}\n');
    const result = parseFrame(buf);
    expect(result.kind).toBe('message');
  });
});

// ─── Subprocess integration test (issue #13) ───

describe('hippo mcp stdio (issue #13)', () => {
  let tmpHome: string;
  let tmpHippo: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevHippoHome: string | undefined;
  let proc: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-test-'));
    tmpHippo = path.join(tmpHome, '.hippo');
    fs.mkdirSync(tmpHippo, { recursive: true });
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.env.HIPPO_HOME = tmpHippo;
  });

  afterEach(async () => {
    if (proc && proc.exitCode === null) {
      const exited = new Promise<void>((resolve) => proc!.once('exit', () => resolve()));
      proc.kill('SIGKILL');
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    process.env.HIPPO_HOME = prevHippoHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // Windows occasionally holds file handles briefly after process exit.
    }
  });

  it('responds to NDJSON initialize while stdin stays open', async () => {
    const serverPath = path.resolve('dist/mcp/server.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Build first: ${serverPath} missing`);
    }
    proc = spawn(process.execPath, [serverPath], {
      cwd: tmpHome,
      env: { ...process.env, HIPPO_HOME: tmpHippo },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const responses: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    let stdoutBuffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf-8');
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else responses.push(line);
      }
    });

    const waitForResponse = (timeoutMs: number) =>
      new Promise<string>((resolve, reject) => {
        const cached = responses.shift();
        if (cached) return resolve(cached);
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`No response in ${timeoutMs}ms (issue #13 regression)`));
        }, timeoutMs);
        const waiter = (line: string) => {
          clearTimeout(timer);
          resolve(line);
        };
        waiters.push(waiter);
      });

    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0' },
      },
    });
    proc.stdin.write(initMsg + '\n');
    // Critically: do NOT close stdin. This is what mcp2cli does and what
    // issue #13 says hangs forever.

    const responseLine = await waitForResponse(5000);
    const response = JSON.parse(responseLine);
    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(1);
    expect(response.result?.protocolVersion).toBe('2024-11-05');
    expect(response.result?.serverInfo?.name).toBe('hippo-memory');

    // A second message on the same open stdin should also get a response.
    const listMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    proc.stdin.write(listMsg + '\n');
    const listLine = await waitForResponse(5000);
    const listResp = JSON.parse(listLine);
    expect(listResp.id).toBe(2);
    expect(Array.isArray(listResp.result?.tools)).toBe(true);
    expect(listResp.result.tools.length).toBeGreaterThan(0);
  }, 15000);
});
