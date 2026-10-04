// Shared setup for the dashboard server tests: a tmp store, seeded memories on a fixed clock, a loopback server and a tiny HTTP client.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initStore } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { upsertVectors } from '../../src/vector-store.js';
import type { MemoryEntry } from '../../src/memory.js';
import { createMemory } from './default-half-life-memory.js';
import { serveDashboard } from '../../src/dashboard.js';

export const NOW = Date.parse('2026-10-01T12:00:00.000Z');
export const DAY = 86_400_000;

export function isoAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

export interface TmpStore {
  home: string;
  hippoRoot: string;
  cleanup: () => void;
}

/** A fresh store under tmp with HIPPO_HOME and HIPPO_TENANT isolated; `cleanup` restores both. */
export function makeStore(prefix: string): TmpStore {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const hippoRoot = join(home, '.hippo');
  mkdirSync(hippoRoot, { recursive: true });
  initStore(hippoRoot);
  const prevTenant = process.env.HIPPO_TENANT;
  const prevHome = process.env.HIPPO_HOME;
  delete process.env.HIPPO_TENANT;
  process.env.HIPPO_HOME = join(home, '.hippo-global');
  return {
    home,
    hippoRoot,
    cleanup: () => {
      if (prevTenant === undefined) delete process.env.HIPPO_TENANT;
      else process.env.HIPPO_TENANT = prevTenant;
      if (prevHome === undefined) delete process.env.HIPPO_HOME;
      else process.env.HIPPO_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Writes one memory in project `alpha`, five days old with a 100 day half-life (strong, not at risk), unless `over` says otherwise. */
export function seed(hippoRoot: string, content: string, over: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry: MemoryEntry = {
    ...createMemory(content, { tags: [] }),
    origin_project: 'alpha',
    half_life_days: 100,
    created: isoAgo(5),
    last_retrieved: isoAgo(5),
    ...over,
  };
  writeEntry(hippoRoot, entry);
  return entry;
}

/** Stores a small vector for each id in memory_vectors, as an embed run would. */
export function embed(hippoRoot: string, ids: readonly string[]): void {
  const db = openHippoDb(hippoRoot);
  try {
    upsertVectors(db, ids.map((id) => [id, [0.1, 0.2]] as const), 'test-model');
  } finally {
    closeHippoDb(db);
  }
}

/** The access token every fixture dashboard starts with; `call` sends it as the session cookie. */
export const DASHBOARD_TOKEN = 'test-dashboard-token';

export interface RunningDashboard {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startDashboard(hippoRoot: string, now: () => number = () => NOW): Promise<RunningDashboard> {
  // One test clock drives both the projections and the cache age.
  const server = serveDashboard(hippoRoot, 0, DASHBOARD_TOKEN, { now, cacheClock: now });
  const port = await new Promise<number>((resolve) => {
    const done = (): void => {
      // SAFETY: serveDashboard binds a TCP port, so address() is an AddressInfo once listening.
      resolve((server.address() as AddressInfo).port);
    };
    if (server.listening) done();
    else server.once('listening', done);
  });
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return { server, port, close };
}

export interface Reply {
  status: number;
  body: string;
}

export interface CallOptions {
  headers?: Record<string, string>;
  body?: string;
}

export function call(port: number, method: string, path: string, opts: CallOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = { cookie: `hippo_dashboard_${port}=${DASHBOARD_TOKEN}`, ...opts.headers };
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

export function get(port: number, path: string): Promise<Reply> {
  return call(port, 'GET', path);
}

/** Any JSON value a test may send as a body. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function postJson(port: number, path: string, payload: Json = {}, headers: Record<string, string> = {}): Promise<Reply> {
  return call(port, 'POST', path, { headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(payload) });
}

/** Parses a reply body; the caller names the shape it expects from the wire contract. */
export function parse<T>(reply: Reply): T {
  // SAFETY: each test asserts the status first and names the dashboard-types shape it reads.
  return JSON.parse(reply.body) as T;
}
