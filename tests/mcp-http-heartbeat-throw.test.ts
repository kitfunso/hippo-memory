import { describe, it, expect, vi, afterEach } from 'vitest';
import { serve, type ServerHandle } from '../src/server.js';
import { waitFor } from './_helpers/wait-for.js';
import { makeRoot } from './_helpers/make-root.js';

describe('SSE heartbeat when its tick throws', () => {
  let root: string;
  let handle: ServerHandle | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    await handle?.stop().catch(() => {});
    delete process.env.MCP_SSE_HEARTBEAT_MS;
  });

  it('keeps ticking after a tick rejects', async () => {
    root = makeRoot('heartbeat-throw');
    process.env.MCP_SSE_HEARTBEAT_MS = '100';
    let failing = false;
    let resolverCalls = 0;
    handle = await serve({
      hippoRoot: root,
      host: '127.0.0.1',
      port: 0,
      authResolver: () => {
        resolverCalls += 1;
        if (failing) throw new Error('auth provider down');
        return { tenantId: 'ext-tenant', subject: 'user-1', role: 'member', scopes: [] };
      },
    });

    const ac = new AbortController();
    try {
      const res = await fetch(`${handle.url}/mcp/stream`, {
        headers: { accept: 'text/event-stream', authorization: 'Bearer ext.good' },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      // An outage tick logs a warn inside the verdict handler; a throwing log write makes that handler reject.
      const real = process.stderr.write.bind(process.stderr);
      const seen: string[] = [];
      // SAFETY: the stub takes the one chunk argument every log write passes; no caller here uses encoding or callback.
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        const line = String(chunk);
        seen.push(line);
        if (line.includes('heartbeat tick skipped')) throw new Error('stderr closed');
        return real(chunk);
      }) as typeof process.stderr.write);
      failing = true;
      const before = resolverCalls;
      await waitFor(() => resolverCalls >= before + 3, { timeoutMs: 3000, what: "three heartbeat ticks" });
      expect(seen.some((l) => l.includes('heartbeat tick failed'))).toBe(true);
    } finally {
      ac.abort();
    }
  });
});
