// The HTTP status of a failed request follows the error's class, never its message, and an untyped error never shows its text.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { createApiKey } from '../src/auth.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../src/api-errors.js';
import { BodyTooLargeError, HttpError, INTERNAL_ERROR_MESSAGE, mapApiError } from '../src/http-util.js';

type ReplyBody = Record<string, string>;

interface Reply { status: number; body: ReplyBody; requestIdHeader: string | null }

interface ProbeRequest {
  method: string;
  path: string;
  body?: Record<string, string | number>;
  headers?: Record<string, string>;
}

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-error-class-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

async function call(handle: ServerHandle, r: ProbeRequest): Promise<Reply> {
  const res = await fetch(`${handle.url}${r.path}`, {
    method: r.method,
    headers: { 'content-type': 'application/json', ...r.headers },
    body: r.body === undefined ? undefined : JSON.stringify(r.body),
  });
  const body: ReplyBody = await res.json();
  return { status: res.status, body, requestIdHeader: res.headers.get('x-request-id') };
}

describe('mapApiError maps by class, never by message', () => {
  const typed: Array<[Error, number]> = [
    [new BadRequestError('wording one'), 400],
    [new ForbiddenError('wording two'), 403],
    [new NotFoundError('wording three'), 404],
    [new ConflictError('wording four'), 409],
    [new HttpError(418, 'teapot'), 418],
    [new BodyTooLargeError('request body exceeds 1MB'), 413],
  ];
  it.each(typed)('%s keeps its own message at %i', (err, status) => {
    expect(mapApiError(err)).toEqual({ status, message: err.message });
  });

  it('a renamed message keeps its status', () => {
    expect(mapApiError(new NotFoundError('no such row (reworded)')).status).toBe(404);
    expect(mapApiError(new ConflictError('row moved on')).status).toBe(409);
  });

  it('old message text on a plain Error no longer buys a 4xx, and the text is withheld', () => {
    for (const text of ['memory not found: mem_x', 'Unknown key_id: k_x', 'Memory m is already superseded by n', 'scope s requires admin role']) {
      expect(mapApiError(new Error(text))).toEqual({ status: 500, message: INTERNAL_ERROR_MESSAGE });
    }
    expect(mapApiError('a thrown string')).toEqual({ status: 500, message: INTERNAL_ERROR_MESSAGE });
  });
});

describe('typed errors from real domain paths keep their status and message', () => {
  let home: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    home = makeRoot();
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  it('BadRequestError -> 400: content under the minimum length', async () => {
    const r = await call(handle, { method: 'POST', path: '/v1/memories', body: { content: 'ab' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Memory content too short (2 chars, minimum 3): "ab"');
  });

  it('NotFoundError -> 404: forget on an unknown id', async () => {
    const r = await call(handle, { method: 'DELETE', path: '/v1/memories/mem_doesnotexist' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('memory not found: mem_doesnotexist');
  });

  it('ConflictError -> 409: superseding a row that is already superseded', async () => {
    const old = createMemory('the build runs on node 20', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
    writeEntry(home, old);
    const first = await call(handle, { method: 'POST', path: `/v1/memories/${old.id}/supersede`, body: { content: 'the build runs on node 22' } });
    expect(first.status).toBe(200);
    const r = await call(handle, { method: 'POST', path: `/v1/memories/${old.id}/supersede`, body: { content: 'the build runs on node 24' } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/is already superseded by/);
  });

  it('ForbiddenError -> 403: a member key cannot mint keys', async () => {
    const db = openHippoDb(home);
    let plaintext: string;
    try {
      plaintext = createApiKey(db, { tenantId: 'default', label: 'member-test', role: 'member' }).plaintext;
    } finally {
      closeHippoDb(db);
    }
    const r = await call(handle, {
      method: 'POST',
      path: '/v1/auth/keys',
      body: { role: 'member' },
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('Only an admin key can create API keys');
  });

  it('a missing row named by a create stays 409', async () => {
    const r = await call(handle, { method: 'POST', path: '/v1/decisions', body: { text: 'use sqlite', supersedesDecisionId: 999 } });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('to supersede not found');
  });
});

describe('an untyped error is a 500 that hides its text', () => {
  let home: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    // A directory where the database file should be makes SQLite fail with its own, untyped error. It is made
    // before serve starts because a running server holds the file open, and Windows refuses to delete an open file.
    home = mkdtempSync(join(tmpdir(), 'hippo-error-class-'));
    mkdirSync(join(home, 'hippo.db'));
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(home, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a generic body with the request id and logs the cause with that id', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const r = await call(handle, { method: 'GET', path: '/v1/audit', headers: { 'x-request-id': 'req-s1b-500' } });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: INTERNAL_ERROR_MESSAGE, requestId: 'req-s1b-500' });
    expect(r.requestIdHeader).toBe('req-s1b-500');
    const line = writes.find((w) => w.includes('requestId=req-s1b-500'));
    expect(line).toMatch(/^\[hippo\] error: GET \/v1\/audit failed: \S/);
    expect(line).toContain('status=500');
    expect(line).toMatch(/ errorClass=\w+ stack=\w*Error: .+ at /);
    expect(line).not.toContain(INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(r.body)).not.toContain(' at ');
  });
});
