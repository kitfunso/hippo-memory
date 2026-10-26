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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { jsonAs } from '../_helpers/http-objects-server.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-sw');
  for (let i = 0; i < 10; i++) {
    writeEntry(
      home,
      createMemory(`alpha ${i}`, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Buffer,
        kind: 'raw',
        tenantId: 'default',
      }),
    );
  }
  handle = await serveKeyed({ hippoRoot: home, port: 0 }, serve);
});
afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories scorer_window', () => {
  it('scorer_window=5 narrows the candidate pool: response.windowSize=5', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha&scorer_window=5`);
    expect(res.status).toBe(200);
    const body = await jsonAs<{ windowSize?: number; total?: number }>(res);
    expect(body.windowSize).toBe(5);
    expect(body.total).toBe(5);
  });

  // 'abc' is forwarded as NaN and recall() rejects it.
  it.each(['0', 'abc'])('scorer_window=%s returns 400 with code=invalid_scorer_window', async (value) => {
    const res = await fetch(`${handle.url}/v1/memories?q=alpha&scorer_window=${value}`);
    expect(res.status).toBe(400);
    const body = await jsonAs<{ error?: string; code?: string }>(res);
    expect(body.code).toBe('invalid_scorer_window');
  });

  it('caps what one remote recall can load and strengthen at 1000', async () => {
    for (const qs of ['scorer_window=1001', 'limit=1001', 'limit=1.5']) {
      const res = await fetch(`${handle.url}/v1/memories?q=alpha&${qs}`);
      expect(res.status, qs).toBe(400);
    }
    expect((await fetch(`${handle.url}/v1/memories?q=alpha&scorer_window=1000&limit=1000`)).status).toBe(200);
  });
});
