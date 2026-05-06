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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-f5-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;
let prevEnv: string | undefined;

beforeEach(async () => {
  home = makeRoot();
  prevEnv = process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
  delete process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  if (prevEnv === undefined) {
    delete process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
  } else {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = prevEnv;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('GET /v1/memories fresh-tail policy F5 (v1.6.5)', () => {
  it('env unset: fresh_tail_count > 0 without session_id → 200 (back-compat tenant-wide)', async () => {
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
      }));
    }
    const res = await fetch(`${handle.url}/v1/memories?q=event&fresh_tail_count=3`);
    expect(res.status).toBe(200);
  });

  it('env=1, no session_id, fresh_tail_count > 0 → 400 with structured body', async () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
      }));
    }
    const res = await fetch(`${handle.url}/v1/memories?q=event&fresh_tail_count=3`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('fresh_tail_requires_session_id');
    expect(typeof body.message).toBe('string');
    expect(body.message).toContain('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL');
  });

  it('env=1, session_id provided → 200 (no error)', async () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        source_session_id: 'sess-A',
      }));
    }
    const res = await fetch(
      `${handle.url}/v1/memories?q=event&fresh_tail_count=3&fresh_tail_session_id=sess-A`,
    );
    expect(res.status).toBe(200);
  });

  it('env=1, fresh_tail_count=0 (or absent) → 200 (guard fires only when fresh-tail requested)', async () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    writeEntry(home, createMemory('event', {
      layer: Layer.Buffer,
      kind: 'raw' as MemoryKind,
    }));
    const res = await fetch(`${handle.url}/v1/memories?q=event`);
    expect(res.status).toBe(200);
  });
});
