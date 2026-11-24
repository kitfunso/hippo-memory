import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-windowsize');
  writeEntry(
    home,
    createMemory('alpha', {
      baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      layer: Layer.Buffer,
      kind: 'raw',
      tenantId: 'default',
    }),
  );
  handle = await serveKeyed({ hippoRoot: home, port: 0 }, serve);
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

  it('serve() sets keepAliveTimeout=65000 and headersTimeout=70000 on the underlying server', () => {
    expect(handle.server?.keepAliveTimeout).toBe(65000);
    expect(handle.server?.headersTimeout).toBe(70000);
    type ServerWithKeepAliveBuffer = NonNullable<typeof handle.server> & { keepAliveTimeoutBuffer?: number };
    // SAFETY: keepAliveTimeoutBuffer is a real but undocumented node:http Server property
    // (Node 22.19+/24.6+); handle.server is the live server instance under test, so the
    // extra optional field is a compatible narrowing, not an unrelated shape.
    const buffer = (handle.server as ServerWithKeepAliveBuffer | undefined)?.keepAliveTimeoutBuffer ?? 0;
    expect(handle.server!.headersTimeout).toBeGreaterThan(handle.server!.keepAliveTimeout + buffer);
  });
});
