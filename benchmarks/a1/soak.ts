/**
 * 24h soak harness — A1 ROADMAP success criterion.
 *
 * v0.39: scaffold for 24h soak runs. NOT a release gate. Operators can run
 * manually; no CI integration. Real-soak-as-evidence is a v0.40+ effort.
 *
 * Drives the server with a steady-state mixed workload (recall/remember/forget)
 * for N hours and tracks RSS, heap, FD count, SQLite WAL size, and request
 * latency in 60s windows. The actual 24h run is manual / scheduled; this
 * harness delivers the skeleton and a smoke run.
 *
 * Run:
 *   npm run build
 *   node --experimental-strip-types benchmarks/a1/soak.ts \
 *     --hours 24 --concurrency 4 --rps 20
 *
 * Smoke (~36s):
 *   node --experimental-strip-types benchmarks/a1/soak.ts \
 *     --hours 0.01 --concurrency 2 --rps 5
 *
 * Output:
 *   benchmarks/a1/results/soak-<timestamp>.jsonl  (one sample per minute)
 *
 * Workload mix:
 *   80% recalls   (GET  /v1/memories?q=...)
 *   18% remembers (POST /v1/memories)
 *    2% forgets   (DELETE /v1/memories/:id)
 *
 * SIGINT shuts down gracefully and prints a final summary. On Linux/Mac the
 * FD count is read from /proc/self/fd; on Windows it is logged as null
 * (no equivalent without WinAPI bindings).
 */

import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, readdirSync, appendFileSync,
} from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initStore } from '../../dist/store.js';
import { remember as apiRemember } from '../../dist/api.js';
import { serve, type ServerHandle } from '../../dist/server.js';

interface CliArgs {
  hours: number;
  concurrency: number;
  rps: number;
  port: number;
}

interface Sample {
  ts: string;
  elapsed_s: number;
  rss_mb: number;
  heap_mb: number;
  fd_count: number | null;
  wal_size_mb: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  p99_ms: number | null;
  rps_observed: number;
  errors_window: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { hours: 24, concurrency: 4, rps: 20, port: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hours') args.hours = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--rps') args.rps = Number(argv[++i]);
    else if (a === '--port') args.port = Number(argv[++i]);
  }
  return args;
}

const SEED_TAGS = ['auth', 'database', 'deploy', 'people', 'food', 'api',
  'python', 'frontend', 'infra', 'docs'];

const QUERIES = [
  'auth migration', 'oauth token', 'production deployment', 'database schema',
  'API rate limit', 'Python deployment', 'standup time', 'login session',
  'kubernetes rollout', 'react component', 'nginx certificate', 'changelog entry',
  'jwt bearer', 'postgres index', 'staging container', 'team manager',
];

function seedStore(home: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const tag = SEED_TAGS[i % SEED_TAGS.length]!;
    apiRemember(
      { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' },
      {
        content: `seed-${i} ${tag} ${QUERIES[i % QUERIES.length]} payload number ${i}`,
        tags: [tag],
      },
    );
  }
}

function readFdCount(): number | null {
  if (platform() !== 'linux' && platform() !== 'darwin') return null;
  try {
    const fdDir = '/proc/self/fd';
    return readdirSync(fdDir).length;
  } catch {
    return null;
  }
}

function readWalSizeMb(home: string): number | null {
  // db.ts puts hippo.db at the hippoRoot top level (`<home>/hippo.db`). The
  // SQLite WAL file is `<dbpath>-wal`. The current server architecture opens
  // and closes the DB per request, which auto-checkpoints and removes the WAL
  // between requests, so this often returns null. Kept for forward-compat
  // (long-lived connection mode would surface real WAL growth here).
  for (const candidate of [join(home, 'hippo.db-wal'), join(home, '.hippo', 'hippo.db-wal')]) {
    try {
      const s = statSync(candidate);
      return s.size / 1024 / 1024;
    } catch { /* keep trying */ }
  }
  return null;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

interface WindowState {
  latencies: number[];
  errors: number;
  totalRequests: number;
}

function newWindow(): WindowState {
  return { latencies: [], errors: 0, totalRequests: 0 };
}

type RequestKind = 'recall' | 'remember' | 'forget';

function pickKind(): RequestKind {
  const r = Math.random();
  if (r < 0.80) return 'recall';
  if (r < 0.98) return 'remember';
  return 'forget';
}

interface RecentIds {
  buf: string[];
  cap: number;
}

function pushRecent(recent: RecentIds, id: string): void {
  recent.buf.push(id);
  if (recent.buf.length > recent.cap) recent.buf.shift();
}

function takeRecent(recent: RecentIds): string | null {
  if (recent.buf.length === 0) return null;
  const idx = Math.floor(Math.random() * recent.buf.length);
  return recent.buf.splice(idx, 1)[0]!;
}

async function doRequest(
  url: string,
  kind: RequestKind,
  recent: RecentIds,
): Promise<{ ok: boolean; latencyMs: number; idCreated?: string }> {
  const t0 = performance.now();
  try {
    if (kind === 'recall') {
      const q = QUERIES[Math.floor(Math.random() * QUERIES.length)]!;
      const res = await fetch(`${url}/v1/memories?q=${encodeURIComponent(q)}&limit=10`);
      await res.text();
      return { ok: res.ok, latencyMs: performance.now() - t0 };
    } else if (kind === 'remember') {
      const tag = SEED_TAGS[Math.floor(Math.random() * SEED_TAGS.length)]!;
      const res = await fetch(`${url}/v1/memories`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          content: `soak-${Date.now()}-${Math.random().toString(36).slice(2, 8)} ${tag}`,
          tags: [tag],
        }),
      });
      const body = await res.text();
      let idCreated: string | undefined;
      if (res.ok) {
        try {
          const parsed = JSON.parse(body) as { id?: string };
          if (parsed.id) idCreated = parsed.id;
        } catch { /* ignore */ }
      }
      return { ok: res.ok, latencyMs: performance.now() - t0, idCreated };
    } else {
      const id = takeRecent(recent);
      if (!id) {
        // Fall back to a recall if we have nothing to forget yet.
        const res = await fetch(`${url}/v1/memories?q=anything&limit=1`);
        await res.text();
        return { ok: res.ok, latencyMs: performance.now() - t0 };
      }
      const res = await fetch(`${url}/v1/memories/${id}`, { method: 'DELETE' });
      await res.text();
      return { ok: res.ok, latencyMs: performance.now() - t0 };
    }
  } catch {
    return { ok: false, latencyMs: performance.now() - t0 };
  }
}

async function workerLoop(
  workerId: number,
  url: string,
  perWorkerRps: number,
  stopAt: number,
  shouldStop: () => boolean,
  window: { current: WindowState },
  recent: RecentIds,
): Promise<void> {
  const intervalMs = 1000 / perWorkerRps;
  let nextAt = Date.now();
  while (Date.now() < stopAt && !shouldStop()) {
    const now = Date.now();
    if (now < nextAt) {
      await new Promise((r) => setTimeout(r, nextAt - now));
    }
    nextAt += intervalMs;
    if (shouldStop() || Date.now() >= stopAt) break;
    const kind = pickKind();
    const result = await doRequest(url, kind, recent);
    const w = window.current;
    w.totalRequests++;
    if (result.ok) {
      w.latencies.push(result.latencyMs);
      if (result.idCreated) pushRecent(recent, result.idCreated);
    } else {
      w.errors++;
    }
    void workerId;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const totalSeconds = Math.round(args.hours * 3600);
  console.log(`[soak] hours=${args.hours} (${totalSeconds}s) concurrency=${args.concurrency} rps=${args.rps} port=${args.port}`);

  const home = mkdtempSync(join(tmpdir(), 'hippo-soak-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);

  console.log(`[soak] hippoRoot=${home}`);
  console.log('[soak] seeding 1000 memories...');
  const seedStart = Date.now();
  seedStore(home, 1000);
  console.log(`[soak] seed done in ${Date.now() - seedStart}ms`);

  const server: ServerHandle = await serve({ hippoRoot: home, port: args.port });
  console.log(`[soak] server listening on ${server.url}`);

  // Output file
  const here = dirname(fileURLToPath(import.meta.url));
  const resultsDir = resolve(here, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(resultsDir, `soak-${stamp}.jsonl`);
  console.log(`[soak] writing samples to ${outPath}`);

  // RSS baseline taken AFTER seed + server start. Growth is measured against
  // this steady-state baseline; seed allocations are excluded from the leak
  // signal. Forces a GC pass first if --expose-gc was set.
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') maybeGc();
  await new Promise((r) => setTimeout(r, 100));
  const initialRss = process.memoryUsage().rss;
  let maxRss = initialRss;
  let totalRequests = 0;
  let totalErrors = 0;
  let samplesWritten = 0;

  const startedAt = Date.now();
  const stopAt = startedAt + totalSeconds * 1000;

  // Window state, swapped on each sample tick.
  const windowRef = { current: newWindow() };
  let lastSampleAt = startedAt;
  const recent: RecentIds = { buf: [], cap: 200 };

  let stopRequested = false;
  const shouldStop = (): boolean => stopRequested;

  const onSigint = (): void => {
    if (stopRequested) return;
    stopRequested = true;
    console.log('\n[soak] SIGINT received, draining workers...');
  };
  process.on('SIGINT', onSigint);

  const perWorkerRps = Math.max(0.1, args.rps / args.concurrency);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < args.concurrency; i++) {
    workers.push(workerLoop(i, server.url, perWorkerRps, stopAt, shouldStop, windowRef, recent));
  }

  // Sample at 60s windows (or earlier on stop).
  const sampleEveryMs = 60_000;
  let nextSampleAt = startedAt + sampleEveryMs;

  const writeSample = (_forceLastWindow: boolean): void => {
    const now = Date.now();
    const windowState = windowRef.current;
    windowRef.current = newWindow();

    const latencies = [...windowState.latencies].sort((a, b) => a - b);
    const rss = process.memoryUsage().rss;
    const heap = process.memoryUsage().heapUsed;
    if (rss > maxRss) maxRss = rss;

    const elapsedSec = (now - startedAt) / 1000;
    const windowDurationSec = Math.max(0.001, (now - lastSampleAt) / 1000);
    lastSampleAt = now;

    const sample: Sample = {
      ts: new Date(now).toISOString(),
      elapsed_s: Math.round(elapsedSec),
      rss_mb: rss / 1024 / 1024,
      heap_mb: heap / 1024 / 1024,
      fd_count: readFdCount(),
      wal_size_mb: readWalSizeMb(home),
      p50_ms: percentile(latencies, 0.5),
      p95_ms: percentile(latencies, 0.95),
      p99_ms: percentile(latencies, 0.99),
      rps_observed: windowState.totalRequests / windowDurationSec,
      errors_window: windowState.errors,
    };
    appendFileSync(outPath, JSON.stringify(sample) + '\n');
    totalRequests += windowState.totalRequests;
    totalErrors += windowState.errors;
    samplesWritten++;

    console.log(
      `[soak] t=${sample.elapsed_s}s rss=${sample.rss_mb.toFixed(1)}MB heap=${sample.heap_mb.toFixed(1)}MB ` +
      `wal=${sample.wal_size_mb !== null ? sample.wal_size_mb.toFixed(2) + 'MB' : 'n/a'} ` +
      `fd=${sample.fd_count ?? 'n/a'} ` +
      `p50=${sample.p50_ms !== null ? sample.p50_ms.toFixed(1) : 'n/a'} ` +
      `p99=${sample.p99_ms !== null ? sample.p99_ms.toFixed(1) : 'n/a'} ` +
      `rps=${sample.rps_observed.toFixed(2)} err=${sample.errors_window}`
    );
  };

  // Sampling tick loop runs concurrently with workers. Polls on a 1s tick so
  // a SIGINT or short --hours run exits without burning the rest of a minute.
  const sampler = (async (): Promise<void> => {
    while (!stopRequested && Date.now() < stopAt) {
      await new Promise((r) => setTimeout(r, 1000));
      if (stopRequested || Date.now() >= stopAt) break;
      if (Date.now() >= nextSampleAt) {
        writeSample(false);
        nextSampleAt += sampleEveryMs;
      }
    }
  })();

  await Promise.all(workers);
  await sampler;

  // Final partial-window sample if anything ran since the last tick.
  if (windowRef.current.totalRequests > 0) {
    writeSample(true);
  }

  process.off('SIGINT', onSigint);

  console.log('[soak] stopping server...');
  await server.stop();

  const finalRss = process.memoryUsage().rss;
  const wallSec = (Date.now() - startedAt) / 1000;

  console.log('');
  console.log('===== soak summary =====');
  console.log(`  wall:            ${wallSec.toFixed(1)}s`);
  console.log(`  total requests:  ${totalRequests}`);
  console.log(`  total errors:    ${totalErrors}`);
  console.log(`  samples written: ${samplesWritten}`);
  console.log(`  initial RSS:     ${(initialRss / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  final RSS:       ${(finalRss / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  max RSS:         ${(maxRss / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  RSS growth:      ${((finalRss - initialRss) / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  output:          ${outPath}`);
  console.log('');

  rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

main().catch((err: Error) => {
  console.error('[soak] fatal:', err);
  process.exit(2);
});
