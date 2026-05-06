/**
 * v1.7.2 T4 — HTTP /v1/memories accepts `scorer_window` query param.
 *
 * Validation lives in api.recall() (RecallContractError on invalid).
 * Transport calls Number(...) and forwards. RecallContractError → 400 with
 * `{error, code: 'invalid_scorer_window'}`.
 *
 * Cross-transport invariant (codex CRITICAL[2]): HTTP and MCP both Number-coerce
 * non-numeric input so `scorer_window=abc` over either transport produces the
 * same typed rejection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-sw-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  for (let i = 0; i < 10; i++) {
    writeEntry(home, createMemory(`alpha ${i}`, {
      layer: Layer.Buffer,
      kind: 'raw' as MemoryKind,
      tenantId: 'default',
    }));
  }
  handle = await serve({ hippoRoot: home, port: 0 });
});
afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories scorer_window (v1.7.2 T4)', () => {
  it('scorer_window=5 narrows the candidate pool: response.windowSize=5', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha&scorer_window=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowSize?: number; total?: number };
    expect(body.windowSize).toBe(5);
    expect(body.total).toBe(5);
  });

  it('scorer_window omitted: response.windowSize=200 (default unchanged)', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { windowSize?: number };
    expect(body.windowSize).toBe(200);
  });

  it('scorer_window=0 returns 400 with code=invalid_scorer_window', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha&scorer_window=0`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('invalid_scorer_window');
  });

  it('scorer_window=abc returns 400 (NaN forwarded; recall() rejects)', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha&scorer_window=abc`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(body.code).toBe('invalid_scorer_window');
  });
});
