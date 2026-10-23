import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import type { JsonObject } from '../../src/base/util/json.js';
import type { ServerHandle } from '../../src/server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { writeEntry, saveActiveTaskSnapshot, appendSessionEvent, saveSessionHandoff } from '../_helpers/root-forms.js';

/** Parse a fetch Response body against a caller-declared shape. */
async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: only used against this file's own /v1/memories route responses,
  // whose JSON shape is fixed by the handler in src/server.ts and checked by
  // the assertions immediately following each call site.
  return (await res.json()) as T;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot('http-cont');
  handle = await serveAsAdmin({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('GET /v1/memories continuity + scope', () => {
  it('default: no continuity, yet no-store on this reply and on a second /v1 route', async () => {
    writeEntry(home, createMemory('memory about deploys', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    const res = await fetch(`${handle.url}/v1/memories?q=deploys`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${handle.url}/v1/graph`)).headers.get('cache-control')).toBe('no-store');
    const body = await jsonAs<{ continuity?: unknown; results: unknown[] }>(res);
    expect(body.continuity).toBeUndefined();
  });

  it('include_continuity=1: returns continuity block with no-store cache header', async () => {
    writeEntry(home, createMemory('memory about deploys', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'HTTP continuity',
      summary: 's',
      nextStep: 'n',
      sessionId: 'sess-http',
      source: 'test',
    });
    saveSessionHandoff(home, 'default', {
      version: 1,
      sessionId: 'sess-http',
      summary: 'h',
      nextAction: 'na',
      artifacts: [],
    });
    await appendSessionEvent(home, 'default', {
      sessionId: 'sess-http',
      eventType: 'note',
      content: 'a trail',
      source: 'test',
    });

    const res = await fetch(`${handle.url}/v1/memories?q=deploys&include_continuity=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await jsonAs<{
      continuity?: { activeSnapshot?: { task: string } | null };
      continuityTokens?: number;
    }>(res);
    expect(body.continuity?.activeSnapshot?.task).toBe('HTTP continuity');
    // Snapshot 4 + 1 + 1, handoff 1 + 1, event 2, each at Math.ceil(len/4).
    expect(body.continuityTokens).toBe(10);

    const blank = await fetch(
      `${handle.url}/v1/memories?q=deploys&include_continuity=true&fresh_tail_session_id=&session_id=%20%20`,
    );
    expect(blank.status).toBe(200);
    expect(blank.headers.get('cache-control')).toBe('no-store');
  });

  it('default-deny scope: private snapshot does NOT leak via HTTP', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private HTTP task',
      summary: 'P',
      nextStep: 'P',
      sessionId: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const res = await fetch(`${handle.url}/v1/memories?q=anything&include_continuity=1`);
    const body = await jsonAs<{
      continuity?: { activeSnapshot?: { task: string } | null };
    }>(res);
    expect(body.continuity?.activeSnapshot).toBeNull();
  });

  it('explicit scope: returns the matching private snapshot', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private HTTP task',
      summary: 'P',
      nextStep: 'P',
      sessionId: 'sess-private',
      source: 'test',
      scope: 'slack:private:Csecret',
    });

    const url = `${handle.url}/v1/memories?q=anything&include_continuity=1&scope=${encodeURIComponent('slack:private:Csecret')}`;
    const res = await fetch(url);
    const body = await jsonAs<{
      continuity?: { activeSnapshot?: { task: string } | null };
    }>(res);
    expect(body.continuity?.activeSnapshot?.task).toBe('Private HTTP task');
  });
});

// The port's session rows are camelCase; these pin the snake_case JSON both routes have always sent.
describe('continuity JSON on the wire', () => {
  const at = (json: string): string => json.replace(/"\d{4}-\d{2}-\d{2}[T ][^"]*"/g, '"<at>"');
  const SNAPSHOT_JSON =
    '{"id":1,"task":"pin the wire","summary":"s","next_step":"n","status":"active","source":"test","session_id":"sess-wire","scope":null,"created_at":"<at>","updated_at":"<at>"}';
  const EVENTS_JSON =
    '[{"id":1,"session_id":"sess-wire","task":null,"event_type":"note","content":"a trail","source":"test","scope":null,"metadata":{"k":1},"created_at":"<at>"}]';

  async function seedSession(): Promise<void> {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'pin the wire',
      summary: 's',
      nextStep: 'n',
      sessionId: 'sess-wire',
      source: 'test',
    });
    await appendSessionEvent(home, 'default', {
      sessionId: 'sess-wire',
      eventType: 'note',
      content: 'a trail',
      source: 'test',
      metadata: { k: 1 },
    });
  }

  it('GET /v1/memories include_continuity sends snake_case snapshot and event keys', async () => {
    await seedSession();
    const res = await fetch(`${handle.url}/v1/memories?q=wire&include_continuity=1`);
    expect(res.status).toBe(200);
    const body = await jsonAs<JsonObject>(res);
    expect(at(JSON.stringify(body.continuity))).toBe(
      `{"activeSnapshot":${SNAPSHOT_JSON},"sessionHandoff":null,"recentSessionEvents":${EVENTS_JSON}}`,
    );
  });

  it('GET /v1/context sends snake_case snapshot and event keys', async () => {
    await seedSession();
    writeEntry(
      home,
      createMemory('a memory so the context has an entry', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    );
    const res = await fetch(`${handle.url}/v1/context?budget=1500`);
    expect(res.status).toBe(200);
    const body = await jsonAs<JsonObject>(res);
    expect(Object.keys(body)).toEqual(['entries', 'tokens', 'activeSnapshot', 'recentEvents', 'ambientState']);
    expect(at(JSON.stringify({ activeSnapshot: body.activeSnapshot, recentEvents: body.recentEvents }))).toBe(
      `{"activeSnapshot":${SNAPSHOT_JSON},"recentEvents":${EVENTS_JSON}}`,
    );
  });
});
