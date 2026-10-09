// GET /mcp/stream holds a socket and a timer per stream, so each API key (or each IP
// when keyless) gets a bounded number of concurrent streams; a closed stream frees its slot.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/store/auth.js';
import { serve, type ServerHandle } from '../src/server.js';

interface OpenStream {
  status: number;
  abort: () => void;
}

describe('/mcp/stream concurrent stream cap', () => {
  const savedMax = process.env.MCP_SSE_MAX_STREAMS;
  let root: string;
  let handle: ServerHandle;
  const open: OpenStream[] = [];

  async function openStream(headers: Record<string, string> = {}): Promise<OpenStream> {
    const ac = new AbortController();
    const res = await fetch(`${handle.url}/mcp/stream`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: ac.signal,
    });
    if (res.status === 200) {
      // Read the first ping so the stream is known to be registered server-side.
      await res.body!.getReader().read();
    } else {
      await res.text();
    }
    const stream = { status: res.status, abort: () => ac.abort() };
    open.push(stream);
    return stream;
  }

  function mintKey(label: string): string {
    const db = openHippoDb(root);
    try {
      return createApiKey(db, { tenantId: 'default', label }).plaintext;
    } finally {
      closeHippoDb(db);
    }
  }

  beforeEach(async () => {
    process.env.MCP_SSE_MAX_STREAMS = '2';
    root = mkdtempSync(join(tmpdir(), 'hippo-sse-cap-'));
    initStore(root);
    handle = await serve({ hippoRoot: root, port: 0 });
  });

  afterEach(async () => {
    for (const s of open.splice(0)) s.abort();
    await handle.stop();
    if (savedMax === undefined) delete process.env.MCP_SSE_MAX_STREAMS;
    else process.env.MCP_SSE_MAX_STREAMS = savedMax;
    rmSync(root, { recursive: true, force: true });
  });

  it('answers 429 to the stream past the cap and frees a slot when a stream closes', async () => {
    const first = await openStream();
    expect(first.status).toBe(200);
    expect((await openStream()).status).toBe(200);
    expect((await openStream()).status).toBe(429);

    first.abort();
    let status = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      status = (await openStream()).status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe(200);
  });

  it('counts each API key separately from the keyless loopback caller', async () => {
    const keyA = mintKey('sse-cap-a');
    const auth = { authorization: `Bearer ${keyA}` };
    expect((await openStream(auth)).status).toBe(200);
    expect((await openStream(auth)).status).toBe(200);
    expect((await openStream(auth)).status).toBe(429);
    expect((await openStream()).status).toBe(200);
    expect((await openStream({ authorization: `Bearer ${mintKey('sse-cap-b')}` })).status).toBe(200);
  });
});
