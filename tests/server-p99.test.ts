/**
 * Plumbing test for the p99 recall benchmark. Skipped by default — manual run.
 *
 * The actual ROADMAP gate (10k store, 1000 queries, p99 < 50ms) is the
 * standalone benchmark at benchmarks/a1/p99-recall.ts. This test is a
 * downsized smoke run that proves the harness still wires correctly:
 * server starts, queries return 200, latency stats compute, no flake.
 *
 * Run manually:
 *   npx vitest run tests/server-p99.test.ts -t p99 --no-skip
 *   (or remove the .skip locally)
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { remember as apiRemember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

describe.skip('p99 recall benchmark plumbing — manual run', () => {
  it('1k store, 100 queries, reports p99 (no hard gate)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-p99-test-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);

    const tags = ['auth', 'database', 'deploy', 'people', 'food'];
    for (let i = 0; i < 1000; i++) {
      const tag = tags[i % tags.length]!;
      apiRemember(
        { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
        { content: `seed-${tag}-doc-${i} reference content for p99 plumbing test`, tags: [tag] },
      );
    }

    const queries = ['auth migration', 'production deployment', 'API rate limit', 'Bob coffee', 'database query'];
    const handle: ServerHandle = await serve({ hippoRoot: home, port: 0 });
    const samples: number[] = [];

    try {
      for (let i = 0; i < 100; i++) {
        const q = queries[i % queries.length]!;
        const url = `${handle.url}/v1/memories?q=${encodeURIComponent(q)}&limit=10`;
        const t0 = performance.now();
        const res = await fetch(url);
        await res.text();
        expect(res.ok).toBe(true);
        samples.push(performance.now() - t0);
      }
    } finally {
      await handle.stop();
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(0.99 * sorted.length)]!;
    console.log(`[p99-plumbing] p99=${p99.toFixed(2)}ms count=${samples.length}`);
    expect(samples.length).toBe(100);
    expect(p99).toBeGreaterThan(0);

    rmSync(home, { recursive: true, force: true });
  }, 120000);
});
