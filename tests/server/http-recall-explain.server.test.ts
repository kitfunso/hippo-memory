import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerHandle } from '../../src/server.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { remember, type RecallResult } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

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
  handle = await serveKeyed({ hippoRoot: home, port: 0 });
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
    expect(body.results).toHaveLength(2);
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
    expect(body.results).toHaveLength(2);
    for (const item of body.results) {
      expect(item.rerankPipeline).toBeUndefined();
      expect(item.rerankTrace).toBeUndefined();
    }
  });
});
