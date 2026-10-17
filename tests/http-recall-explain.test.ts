/**
 * A7 recall-trace — HTTP /v1/memories explain wire-format.
 *
 * Asserts the A7 fields ride on the GET /v1/memories JSON body under
 * `?explain=1`, and are ABSENT without it (byte-identical default on the
 * wire). Closes plan Test #4 + the code-review med (server pass-through +
 * JSON serialization were previously only inferred from the api unit test).
 * Real SQLite store + real server, no mocks.
 */

import type { FullContext } from './_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { serve, type ServerHandle } from '../src/server.js';
import { remember, type RecallResult } from '../src/api/index.js';
import { apiCtx } from './_helpers/api-ctx.js';
import { makeRoot } from './_helpers/make-root.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let handle: ServerHandle;
let ctx: FullContext;

beforeEach(async () => {
  home = makeRoot('a7-http');
  ctx = apiCtx(home, 'default', { subject: 'test', role: 'admin' });
  await remember(ctx, { content: 'auth bug fix details', tags: ['fix-auth'] });
  await remember(ctx, { content: 'auth UI polish notes', tags: ['ui'] });
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
});

describe('HTTP /v1/memories rerank-trace wire-format', () => {
  it('explain=1 -> every result item carries rerankPipeline:api on the wire', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=auth&explain=1`);
    expect(res.status).toBe(200);
    // SAFETY: /v1/memories's JSON response body is the serialized
    // RecallResult produced by src/api/index.ts's recall(), checked immediately by
    // the assertions that follow.
    const body = (await res.json()) as RecallResult;
    expect(body.results.length).toBeGreaterThan(0);
    for (const item of body.results) {
      expect(item.rerankPipeline).toBe('api');
    }
  });

  it('no explain -> rerankPipeline + rerankTrace absent on the wire (byte-identical default)', async () => {
    const res = await fetch(`${handle.url}/v1/memories?q=auth`);
    expect(res.status).toBe(200);
    // SAFETY: /v1/memories's JSON response body is the serialized
    // RecallResult produced by src/api/index.ts's recall(), checked immediately by
    // the assertions that follow.
    const body = (await res.json()) as RecallResult;
    expect(body.results.length).toBeGreaterThan(0);
    for (const item of body.results) {
      expect(item.rerankPipeline).toBeUndefined();
      expect(item.rerankTrace).toBeUndefined();
    }
  });
});
