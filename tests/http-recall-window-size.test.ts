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
});
