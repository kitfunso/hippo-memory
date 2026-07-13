/**
 * v1.7.1 INFO #6 — RecallResult.windowSize IS serialized over HTTP.
 *
 * v1.7.0 JSDoc claims: "OUTPUT `RecallResult.windowSize` is always serialized
 * over the wire (HTTP `sendJson` ships the whole RecallResult)." Pin that
 * contract: a default GET /v1/memories returns body.windowSize === 200.
 *
 * Note: input-side `scorer_window` parsing is NOT part of v1.7.1 (transport
 * exposure deferred to v1.7.2). This test only covers the OUTPUT side.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-windowsize-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  writeEntry(home, createMemory('alpha', {
    layer: Layer.Buffer,
    kind: 'raw' as MemoryKind,
    tenantId: 'default',
  }));
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories windowSize serialization (v1.7.1 INFO #6)', () => {
  it('default GET /v1/memories?q=alpha returns body.windowSize === 200', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowSize?: number };
    expect(body.windowSize).toBe(200);
  });

  // v1.26.2 T2 — keep-alive hardening. serve() raises the default 5s
  // keepAliveTimeout to shrink the idle-close/reuse race behind the
  // server-concurrency ECONNRESET flake (T3b capture). headersTimeout must
  // exceed the EFFECTIVE keep-alive expiry (keepAliveTimeout + the 1,000ms
  // keepAliveTimeoutBuffer on Node 22.19+/24.6+) — codex P2: 66s sat
  // exactly on the 65s+1s boundary.
  it('serve() sets keepAliveTimeout=65000 and headersTimeout=70000 on the underlying server', () => {
    expect(handle.server?.keepAliveTimeout).toBe(65000);
    expect(handle.server?.headersTimeout).toBe(70000);
    const buffer = (handle.server as unknown as { keepAliveTimeoutBuffer?: number })?.keepAliveTimeoutBuffer ?? 0;
    // Pin the ordering invariant itself, not just the two constants: the
    // headers timer must clear the effective keep-alive expiry.
    expect(handle.server!.headersTimeout).toBeGreaterThan(handle.server!.keepAliveTimeout + buffer);
  });
});
