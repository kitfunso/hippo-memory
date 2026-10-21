import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import { createInterface } from 'readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseFrame } from '../../src/surface/mcp/framing.js';
import { TOOLS } from '../../src/surface/mcp/tools.js';
import { makeRoot } from '../_helpers/make-root.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    const buf = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');
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

describe('hippo mcp stdio', () => {
  let tmpHome: string;
  let tmpHippo: string;
  let proc: ChildProcessWithoutNullStreams | null = null;

  beforeEach(() => {
    tmpHome = makeRoot('mcp-test', { init: false });
    tmpHippo = path.join(tmpHome, '.hippo');
    fs.mkdirSync(tmpHippo, { recursive: true });
    vi.stubEnv('HOME', tmpHome);
    vi.stubEnv('USERPROFILE', tmpHome);
    vi.stubEnv('HIPPO_HOME', tmpHippo);
  });

  afterEach(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // Closing stdin lets the server exit itself and write its coverage; one that never exits fails at the hook timeout.
      const exited = once(proc, 'exit');
      proc.stdin.end();
      await exited;
    }
  });

  it('responds to NDJSON initialize while stdin stays open', async () => {
    const serverPath = path.resolve('dist/surface/mcp/server.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error(`Build first: ${serverPath} missing`);
    }
    proc = spawn(process.execPath, [serverPath], {
      cwd: tmpHome,
      env: { ...process.env, HIPPO_HOME: tmpHippo },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A reply that never comes (the issue #13 hang) fails at the test timeout.
    const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const nextReply = async (): Promise<string> => {
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error('stdout closed before a reply');
        if (value.trim()) return value.trim();
      }
    };

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

    const responseLine = await nextReply();
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
    const listLine = await nextReply();
    const listResp = JSON.parse(listLine);
    expect(listResp.id).toBe(2);
    expect(Array.isArray(listResp.result?.tools)).toBe(true);
    // A tools/list on stdio has no store yet, so it lists every tool.
    expect(listResp.result.tools.map((t: { name: string }) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });
});
