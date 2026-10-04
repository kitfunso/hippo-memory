// An MCP tool that throws an untyped error must not hand its internal text to the client; typed API errors keep theirs.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { serve, type ServerHandle } from '../src/server.js';
import { mcpErrorResponse } from '../src/mcp/server.js';
import { NotFoundError } from '../src/api-errors.js';

interface RpcReply {
  id: number;
  result?: { content: Array<{ text: string }> };
  error?: { code: number; message: string; data?: { requestId?: string } };
}

let home: string;
let handle: ServerHandle;
let stderr: MockInstance<typeof process.stderr.write>;

function stderrText(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join('');
}

async function callTool(name: string, args: Record<string, string>, requestId?: string): Promise<{ status: number; body: RpcReply }> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (requestId) headers.set('x-request-id', requestId);
  const res = await fetch(`${handle.url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }),
  });
  // SAFETY: /mcp always answers a tools/call with a JSON-RPC object; the assertions below check the fields.
  return { status: res.status, body: (await res.json()) as RpcReply };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hippo-mcp-redact-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  handle = await serve({ hippoRoot: home, port: 0 });
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stderr.mockRestore();
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('POST /mcp error replies', () => {
  it('an untyped error inside a tool returns a generic message with the request id, and logs the real text', async () => {
    // A dropped table makes hippo_status hit a real SQLite error whose text names the schema.
    const db = openHippoDb(home);
    try {
      db.exec('DROP TABLE memory_conflicts');
    } finally {
      closeHippoDb(db);
    }
    const { status, body } = await callTool('hippo_status', {}, 'req-redact-1');
    expect(status).toBe(200);
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).not.toMatch(/memory_conflicts|no such table/i);
    expect(body.error?.message).toContain('internal server error');
    expect(body.error?.message).toContain('req-redact-1');
    expect(body.error?.data?.requestId).toBe('req-redact-1');
    expect(stderrText()).toMatch(/\[hippo\] error: mcp request failed: .*memory_conflicts.* requestId=req-redact-1/);
  });

  it('a typed NotFoundError keeps its message', async () => {
    const { body } = await callTool('hippo_share', { id: 'mem_does_not_exist' });
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toBe('Memory not found: mem_does_not_exist');
    expect(body.error?.data).toBeUndefined();
  });
});

describe('mcpErrorResponse (the stdio transport reply)', () => {
  it('hides untyped error text and stamps a fresh request id', () => {
    const reply = mcpErrorResponse(3, new Error('SQLITE_CORRUPT at C:/secret/path.db'));
    expect(reply.error?.message).not.toContain('secret');
    expect(reply.error?.data?.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stderrText()).toContain('SQLITE_CORRUPT at C:/secret/path.db');
  });

  it('keeps a typed error message', () => {
    const reply = mcpErrorResponse('a', new NotFoundError('Memory not found: x'));
    expect(reply).toEqual({ jsonrpc: '2.0', id: 'a', error: { code: -32603, message: 'Memory not found: x' } });
  });
});
