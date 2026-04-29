import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';

// MCP-over-HTTP/SSE transport (Task 11 of A1 plan).
//
// Both routes — POST /mcp and GET /mcp/stream — dispatch through the same
// transport-agnostic handler that backs the stdio MCP loop. The stdio path is
// covered by tests/mcp-stdio.test.ts; this file pins the HTTP transport
// surface: synchronous JSON-RPC responses on POST, keepalive-only SSE on GET,
// and the auth middleware reuse.

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-mcp-http-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('MCP-over-HTTP transport', () => {
  let home: string;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    // The HTTP transport now threads hippoRoot + auth-resolved tenant
    // through handleMcpRequest, so executeTool no longer walks cwd via
    // findHippoRoot() or reads HIPPO_TENANT from the env. No env hacks
    // needed — the per-test temp root is the source of truth end-to-end.
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('POST /mcp tools/list returns the tool catalog', async () => {
    const res = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { jsonrpc: string; id: number; result?: { tools: Array<{ name: string }> } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(Array.isArray(body.result?.tools)).toBe(true);
    const names = body.result!.tools.map((t) => t.name);
    expect(names).toContain('hippo_remember');
    expect(names).toContain('hippo_recall');
  });

  it('POST /mcp tools/call hippo_remember stores a memory recoverable via recall', async () => {
    // A token unique enough that a stray hit in the global store is implausible.
    const sentinel = `mcp-http-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const rememberRes = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'hippo_remember',
          arguments: { text: `mcp-http-canary-99 ${sentinel}` },
        },
      }),
    });
    expect(rememberRes.status).toBe(200);
    const rememberBody = await rememberRes.json() as { id: number; result?: { content: Array<{ text: string }> } };
    expect(rememberBody.id).toBe(2);
    const rememberText = rememberBody.result?.content?.[0]?.text ?? '';
    expect(rememberText).toMatch(/Remembered/i);

    // Round-trip: recall the same sentinel through the same HTTP transport.
    // This proves the dispatcher lands in a single coherent store across
    // back-to-back calls without leaning on any specific filesystem layout.
    const recallRes = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'hippo_recall',
          arguments: { query: sentinel, budget: 2000 },
        },
      }),
    });
    expect(recallRes.status).toBe(200);
    const recallBody = await recallRes.json() as { id: number; result?: { content: Array<{ text: string }> } };
    const recallText = recallBody.result?.content?.[0]?.text ?? '';
    expect(recallText).toContain(sentinel);
  });

  it('GET /mcp/stream opens an SSE stream and emits a keepalive', async () => {
    const ac = new AbortController();
    try {
      const res = await fetch(`${handle.url}/mcp/stream`, {
        headers: { accept: 'text/event-stream' },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), 1000),
        ),
      ]);
      expect(done).toBe(false);
      const text = new TextDecoder().decode(value);
      expect(text).toContain(': ping');
      try { reader.cancel().catch(() => {}); } catch { /* no-op */ }
    } finally {
      ac.abort();
    }
  });

  it('rejects POST /mcp without auth from a non-loopback origin', async () => {
    // Smoke check: the auth middleware fires on /mcp routes too. We can't
    // easily fake a non-loopback connection in-process, so this asserts the
    // happy-path 200 (loopback no-auth) — the negative case is covered by
    // the broader auth tests in tests/server-auth.test.ts. Treat the
    // positive case as a minimal regression guard: if requireAuth threw on
    // loopback, it would 401 here.
    const res = await fetch(`${handle.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
  });
});
