/**
 * F5 (v1.6.5) — HTTP render path for RecallContractError.
 *
 * /v1/memories?fresh_tail_count=N is the HTTP entry point that exercises
 * api.recall's fresh-tail policy. With HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1
 * AND fresh_tail_count > 0 AND no fresh_tail_session_id, the typed error
 * should surface as HTTP 400 with body { error: <code>, message: <string> }.
 *
 * The structured body is what distinguishes F5's response from the existing
 * `sendError` path (which returns just `{ error: <message> }`). Callers can
 * branch on `error === 'fresh_tail_requires_session_id'` without parsing
 * prose.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { writeEntry } from '../_helpers/root-forms.js';

beforeEach(() => {
  vi.stubEnv('HIPPO_ALLOW_KEYLESS_LOCAL', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every call site awaits a `fetch()` response from the local test server started
  // in this file's `beforeEach`, whose route handlers are exercised directly below.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-f5');
  vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', undefined);
  handle = await serve({ hippoRoot: home, port: 0 });
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
    // Body shape (v1.7.0 api-contract review): `error` is the human message
    // (matches sendError shape across v1/*), `code` is the typed
    // discriminator. Clients branch on `body.code`, render `body.error`.
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
