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
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-windowsize');
  writeEntry(home, createMemory('alpha', {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    kind: 'raw',
    tenantId: 'default',
  }));
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories windowSize serialization', () => {
  it('default GET /v1/memories?q=alpha returns body.windowSize === 200', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha`);
    expect(res.status).toBe(200);
    // SAFETY: /v1/memories route under test always responds with a RecallResult JSON body,
    // which per v1.7.0 contract always includes a numeric windowSize field.
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
    type ServerWithKeepAliveBuffer = NonNullable<typeof handle.server> & { keepAliveTimeoutBuffer?: number };
    // SAFETY: keepAliveTimeoutBuffer is a real but undocumented node:http Server property
    // (Node 22.19+/24.6+); handle.server is the live server instance under test, so the
    // extra optional field is a compatible narrowing, not an unrelated shape.
    const buffer = (handle.server as ServerWithKeepAliveBuffer | undefined)?.keepAliveTimeoutBuffer ?? 0;
    // Pin the ordering invariant itself, not just the two constants: the
    // headers timer must clear the effective keep-alive expiry.
    expect(handle.server!.headersTimeout).toBeGreaterThan(handle.server!.keepAliveTimeout + buffer);
  });
});
