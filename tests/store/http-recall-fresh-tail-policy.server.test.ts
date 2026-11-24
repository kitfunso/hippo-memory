import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
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
  home = makeRoot('http-f5');
  vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', undefined);
  handle = await serveKeyed({ hippoRoot: home, port: 0 }, serve);
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('GET /v1/memories fresh-tail policy', () => {
  it('env unset: fresh_tail_count > 0 without session_id → 200 (back-compat tenant-wide)', async () => {
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`event ${i}`, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          layer: Layer.Buffer,
          kind: 'raw',
        }),
      );
    }
    const res = await fetch(`${handle.url}/v1/memories?q=event&fresh_tail_count=3`);
    expect(res.status).toBe(200);
  });

  it('env=1, no session_id, fresh_tail_count > 0 → 400 with structured body', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`event ${i}`, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          layer: Layer.Buffer,
          kind: 'raw',
        }),
      );
    }
    const res = await fetch(`${handle.url}/v1/memories?q=event&fresh_tail_count=3`);
    expect(res.status).toBe(400);
    const body = await jsonAs<{ error: string; code: string }>(res);
    expect(body.code).toBe('fresh_tail_requires_session_id');
    expect(body.error).toBeTypeOf('string');
    expect(body.error).toContain('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL');
  });

  it('env=1, session_id provided → 200 (no error)', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`event ${i}`, {
          baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
          layer: Layer.Buffer,
          kind: 'raw',
          sourceSessionId: 'sess-A',
        }),
      );
    }
    const res = await fetch(`${handle.url}/v1/memories?q=event&fresh_tail_count=3&fresh_tail_session_id=sess-A`);
    expect(res.status).toBe(200);
  });

  it('env=1, fresh_tail_count=0 (or absent) → 200 (guard fires only when fresh-tail requested)', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    writeEntry(
      home,
      createMemory('event', {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        layer: Layer.Buffer,
        kind: 'raw',
      }),
    );
    const res = await fetch(`${handle.url}/v1/memories?q=event`);
    expect(res.status).toBe(200);
  });
});
