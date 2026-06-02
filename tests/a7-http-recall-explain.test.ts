/**
 * A7 recall-trace — HTTP /v1/memories explain wire-format.
 *
 * Asserts the A7 fields ride on the GET /v1/memories JSON body under
 * `?explain=1`, and are ABSENT without it (byte-identical default on the
 * wire). Closes plan Test #4 + the code-review med (server pass-through +
 * JSON serialization were previously only inferred from the api unit test).
 * Real SQLite store + real server, no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';
import { remember, type Context, type RecallResult } from '../src/api.js';

let home: string;
let handle: ServerHandle;
let ctx: Context;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'hippo-a7-http-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'test', role: 'admin' } };
  remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
  remember(ctx, { content: 'auth UI polish notes', tags: ['ui'] });
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('HTTP /v1/memories A7 rerank-trace wire-format', () => {
  it('explain=1 -> every result item carries rerankPipeline:api on the wire', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=auth&explain=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallResult;
    expect(body.results.length).toBeGreaterThan(0);
    for (const item of body.results) {
      expect(item.rerankPipeline).toBe('api');
    }
  });

  it('no explain -> rerankPipeline + rerankTrace absent on the wire (byte-identical default)', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=auth`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallResult;
    expect(body.results.length).toBeGreaterThan(0);
    for (const item of body.results) {
      const raw = item as Record<string, unknown>;
      expect(raw.rerankPipeline).toBeUndefined();
      expect(raw.rerankTrace).toBeUndefined();
    }
  });
});
