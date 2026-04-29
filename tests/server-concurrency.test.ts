import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { remember as apiRemember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

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
          { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
          { content: `seed-${term}-doc-${i} reference content for recall test` },
        );
      }

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
          const responses: Response[] = [];
          for (let chunkStart = 0; chunkStart < readsPerWorker; chunkStart += readChunk) {
            const chunkEnd = Math.min(chunkStart + readChunk, readsPerWorker);
            const fetches: Promise<Response>[] = [];
            for (let reqIdx = chunkStart; reqIdx < chunkEnd; reqIdx++) {
              const term = seedTerms[(workerIdx + reqIdx) % seedTerms.length]!;
              fetches.push(fetch(`${handle.url}/v1/memories?q=${term}&limit=5`));
            }
            const chunkRes = await Promise.all(fetches);
            responses.push(...chunkRes);
          }
          return responses;
        });

        // 1 writer worker, sequential POSTs with unique markers.
        const writeCount = 50;
        const writerWork = (async () => {
          const responses: Response[] = [];
          for (let n = 0; n < writeCount; n++) {
            const res = await fetch(`${handle.url}/v1/memories`, {
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
      }
    },
    60_000,
  );
});
