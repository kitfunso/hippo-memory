// The API embedding provider reads every reply under a size cap, against a real local endpoint.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { boundPort } from './_helpers/listen.js';
import { resolveEmbeddingProvider } from '../src/embeddings/provider.js';

const KEY = 'sk-reply-cap-test';
// One input may reply with up to 64 KiB + 512 KiB; two inputs with 64 KiB + 1 MiB.
const ONE_INPUT_CAP = 64 * 1024 + 512 * 1024;

describe('embedding provider reply cap', () => {
  let server: http.Server;
  let root: string;
  let sent = 0;
  let closedEarly = false;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  let savedKey: string | undefined;

  /** Streams `status` and spaces until the client hangs up or 200 MiB went out. */
  function streamForever(res: http.ServerResponse, status: number, contentType: string): void {
    res.writeHead(status, { 'content-type': contentType });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    res.on('close', () => { closedEarly = true; });
    const pump = (): void => {
      while (sent < 200 * 1024 * 1024 && !closedEarly) {
        sent += chunk.length;
        if (!res.write(chunk)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  }

  beforeEach(async () => {
    sent = 0;
    closedEarly = false;
    savedKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
    server = http.createServer((req, res) => { req.resume(); handler(req, res); });
    server.listen(0, '127.0.0.1');
    const port = await boundPort(server);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-embed-cap-'));
    fs.writeFileSync(
      path.join(root, 'config.json'),
      JSON.stringify({ embeddings: { provider: 'openai', model: 'm', apiBaseUrl: `http://127.0.0.1:${port}` } }),
    );
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  });

  it('fails a one-input request whose reply passes the cap, and the server sees the hang-up', async () => {
    handler = (_req, res) => streamForever(res, 200, 'application/json');
    const err: unknown = await resolveEmbeddingProvider(root).embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error('expected a rejection');
    expect(err.message).toContain('openai embeddings returned invalid JSON');
    expect(err.message).toContain(`reply over ${ONE_INPUT_CAP} bytes`);
    expect(err.message).not.toContain(KEY);
    await vi.waitFor(() => expect(closedEarly).toBe(true));
    expect(sent).toBeLessThan(100 * 1024 * 1024);
  });

  it('still parses a normal-size reply for a multi-input request', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [3, 4] }, { embedding: [0, 2] }, { embedding: [1, 0] }] }));
    };
    const out = await resolveEmbeddingProvider(root).embed(['a', 'b', 'c']);
    expect(out).toEqual([[0.6, 0.8], [0, 1], [1, 0]]);
  });

  it('keeps the HTTP message, cuts the detail and stops reading a huge error body', async () => {
    handler = (_req, res) => streamForever(res, 400, 'text/plain');
    const err: unknown = await resolveEmbeddingProvider(root).embed(['x']).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error('expected a rejection');
    expect(err.message).toBe(`openai embeddings HTTP 400: ${' '.repeat(300)}`);
    await vi.waitFor(() => expect(closedEarly).toBe(true));
    expect(sent).toBeLessThan(100 * 1024 * 1024);
  });
});
