import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember as apiRemember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

// Minimal fetch-Response-shaped result so the assertions below (res.status,
// await res.text(), await res.json()) did not need to change when the
// transport switched off fetch/undici.
interface TracedResponse {
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

interface TracedRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

// T3c (hardening-1.26.2): fresh-TCP-connection transport, replacing fetch.
// T3b captured the mechanism with T3a's diagnostics: "worker 6 req 11
// read-chunk 10: ECONNRESET" / cause read ECONNRESET — a second-chunk reader
// GET reused a kept-alive socket that had idled through the prior chunk
// while the full suite saturated the host; Node's server-side default
// keepAliveTimeout (5s) closed the socket exactly as undici tried to reuse
// it. `node:http`'s `agent: false` opts out of connection pooling entirely
// (an unmanaged, un-pooled socket per request, `Connection: close` sent
// automatically), so this test's requests never depend on keep-alive
// reuse timing again. undici is NOT a dependency here and none is added.
//
// Connection reuse is orthogonal to this test's actual claim (SQLite
// single-writer correctness under concurrent requests, not HTTP keep-alive
// behavior); the socket-lifecycle race itself belongs to T2's server
// keep-alive/headers timeout hardening, not to this test avoiding it.
//
// Permanent failure diagnostics (T3a, ported from the fetch transport):
// a rejection rethrows enriched with worker/request/phase context plus the
// underlying cause code, so any future flake self-describes instead of a
// bare ECONNRESET.
function tracedRequest(label: string, url: string, init?: TracedRequestInit): Promise<TracedResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? 'GET',
        headers: init?.headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            text: async () => bodyText,
            json: async () => JSON.parse(bodyText) as unknown,
          });
        });
        res.on('error', (err) => {
          const code = (err as any)?.cause?.code ?? (err as any)?.code;
          reject(new Error(`${label}: ${code}`, { cause: err }));
        });
      },
    );
    req.on('error', (err) => {
      const code = (err as any)?.cause?.code ?? (err as any)?.code;
      reject(new Error(`${label}: ${code}`, { cause: err }));
    });
    if (init?.body !== undefined) req.write(init.body);
    req.end();
  });
}

// Concurrent recall + write under SQLite single-writer (real DB).
// Proves no SQLite locked errors when readers and a writer hammer the
// server simultaneously. ROADMAP A1 commitment.
describe('server concurrency — recall + write under single-writer', () => {
  it(
    'handles 10 readers x 50 GETs + 50 writes with no SQLite locked errors',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'hippo-srv-conc-'));
      mkdirSync(join(home, '.hippo'), { recursive: true });
      initStore(home);

      // Pre-seed 100 memories spanning a small pool of search terms so
      // recall queries land hits.
      const seedTerms = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      for (let i = 0; i < 100; i++) {
        const term = seedTerms[i % seedTerms.length]!;
        apiRemember(
          { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } },
          { content: `seed-${term}-doc-${i} reference content for recall test` },
        );
      }

      // This test bursts ~550 /v1/* requests from one IP to stress SQLite
      // single-writer locking, an axis orthogonal to the /v1 rate limiter.
      // Disable the limiter (HIPPO_V1_RPS=0) so every request reaches the DB.
      const prevRps = process.env.HIPPO_V1_RPS;
      process.env.HIPPO_V1_RPS = '0';
      const handle: ServerHandle = await serve({ hippoRoot: home, port: 0 });
      const lockedErrors: string[] = [];

      try {
        // 10 reader workers, each issuing 50 parallel GETs against the
        // server. Queries cycle through the seeded terms. Reads are chunked
        // (10 at a time per worker) to avoid bursting all 500 SYN packets
        // into the loopback listener simultaneously, which trips
        // ECONNREFUSED on Windows when the kernel accept queue overflows.
        // Across all 10 workers we still keep ~100 reads in flight at any
        // moment, plenty to exercise the WAL-mode concurrent-reader path.
        const readerCount = 10;
        const readsPerWorker = 50;
        const readChunk = 10;
        const readerWork = Array.from({ length: readerCount }, async (_, workerIdx) => {
          const responses: TracedResponse[] = [];
          for (let chunkStart = 0; chunkStart < readsPerWorker; chunkStart += readChunk) {
            const chunkEnd = Math.min(chunkStart + readChunk, readsPerWorker);
            const fetches: Promise<TracedResponse>[] = [];
            for (let reqIdx = chunkStart; reqIdx < chunkEnd; reqIdx++) {
              const term = seedTerms[(workerIdx + reqIdx) % seedTerms.length]!;
              fetches.push(
                tracedRequest(
                  `worker ${workerIdx} req ${reqIdx} read-chunk ${chunkStart}`,
                  `${handle.url}/v1/memories?q=${term}&limit=5`,
                ),
              );
            }
            const chunkRes = await Promise.all(fetches);
            responses.push(...chunkRes);
          }
          return responses;
        });

        // 1 writer worker, sequential POSTs with unique markers.
        const writeCount = 50;
        const writerWork = (async () => {
          const responses: TracedResponse[] = [];
          for (let n = 0; n < writeCount; n++) {
            const res = await tracedRequest(`writer req ${n} write`, `${handle.url}/v1/memories`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                content: `concurrent-canary-${n}`,
                kind: 'distilled',
              }),
            });
            responses.push(res);
          }
          return responses;
        })();

        const [readerResultsByWorker, writerResults] = await Promise.all([
          Promise.all(readerWork),
          writerWork,
        ]);

        // Validate writes: 50 x 200 with valid envelopes.
        expect(writerResults).toHaveLength(writeCount);
        for (const [idx, res] of writerResults.entries()) {
          if (res.status !== 200) {
            const text = await res.text();
            if (/SQLITE_BUSY|database is locked/i.test(text)) {
              lockedErrors.push(`writer #${idx}: ${text}`);
            }
            throw new Error(`writer #${idx} status=${res.status} body=${text}`);
          }
          const body = (await res.json()) as { id: string; kind: string; tenantId: string };
          expect(body.id).toMatch(/^mem_/);
          expect(body.kind).toBe('distilled');
          expect(body.tenantId).toBe('default');
        }

        // Validate reads: 10 * 50 = 500 x 200, no locked errors.
        const flatReads = readerResultsByWorker.flat();
        expect(flatReads).toHaveLength(readerCount * readsPerWorker);
        for (const [idx, res] of flatReads.entries()) {
          if (res.status !== 200) {
            const text = await res.text();
            if (/SQLITE_BUSY|database is locked/i.test(text)) {
              lockedErrors.push(`reader #${idx}: ${text}`);
            }
            throw new Error(`reader #${idx} status=${res.status} body=${text}`);
          }
          // Drain the body so the socket is released.
          await res.json();
        }

        expect(lockedErrors).toEqual([]);

        // Final DB state: exactly 150 memories (100 seed + 50 concurrent).
        const db = openHippoDb(home);
        try {
          const row = db
            .prepare(`SELECT COUNT(*) AS n FROM memories WHERE tenant_id = 'default'`)
            .get() as { n: number };
          expect(row.n).toBe(150);

          // Spot-check: every concurrent-canary-N marker landed.
          const stmt = db.prepare(
            `SELECT COUNT(*) AS n FROM memories WHERE content = ? AND tenant_id = 'default'`,
          );
          for (let n = 0; n < writeCount; n++) {
            const hit = stmt.get(`concurrent-canary-${n}`) as { n: number };
            expect(hit.n, `marker concurrent-canary-${n} missing`).toBe(1);
          }
        } finally {
          closeHippoDb(db);
        }
      } finally {
        await handle.stop();
        rmSync(home, { recursive: true, force: true });
        if (prevRps === undefined) delete process.env.HIPPO_V1_RPS;
        else process.env.HIPPO_V1_RPS = prevRps;
      }
    },
    60_000,
  );
});
