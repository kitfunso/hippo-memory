// An OpenAI-compatible embeddings endpoint on 127.0.0.1 that hashes letter trigrams into 16 dims, so recall's
// vector arm runs through the real provider with no network and no fetch stub.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const HASHED_DIM = 16;

/** The vector the server answers for `text`, L2-normalised; all zeros only for empty text. */
export function hashedVector(text: string): number[] {
  const v = Array.from({ length: HASHED_DIM }, () => 0);
  const s = ` ${text.toLowerCase()} `;
  for (let i = 0; i + 3 <= s.length; i++) {
    let h = 0x811c9dc5;
    for (let j = i; j < i + 3; j++) h = Math.imul(h ^ s.charCodeAt(j), 0x01000193);
    v[(h >>> 0) % HASHED_DIM] += 1;
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

export interface HashedEmbeddings {
  readonly url: string;
  /** Embedding requests received so far, failed ones included. */
  requests(): number;
  /** Answer every later request with `status`; 200 serves vectors again. */
  setStatus(status: number): void;
  close(): Promise<void>;
}

export async function startHashedEmbeddings(): Promise<HashedEmbeddings> {
  let received = 0;
  let status = 200;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received += 1;
      if (status !== 200) {
        // Retry-After 0 lets the provider's three attempts run without a wait.
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' }).end('{"error":"injected"}');
        return;
      }
      // SAFETY: the openai provider posts {model, input: string[]} here.
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { input: string[] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: body.input.map((t) => ({ embedding: hashedVector(t) })) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on TCP reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => received,
    setStatus: (next) => { status = next; },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}
