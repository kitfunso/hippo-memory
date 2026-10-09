import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot, appendSessionEvent } from '../src/store/sessions.js';
import { saveSessionHandoff } from '../src/store/handoffs.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

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
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('GET /v1/memories continuity + scope', () => {
  it('default: no continuity, no Cache-Control: no-store', async () => {
    writeEntry(home, createMemory('memory about deploys', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    const res = await fetch(`${handle.url}/v1/memories?q=deploys`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).not.toBe('no-store');
    const body = await jsonAs<{ continuity?: unknown; results: unknown[] }>(res);
    expect(body.continuity).toBeUndefined();
  });

  it('include_continuity=1: returns continuity block with no-store cache header', async () => {
    writeEntry(home, createMemory('memory about deploys', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }));
    saveActiveTaskSnapshot(home, 'default', {
      task: 'HTTP continuity',
      summary: 's',
      next_step: 'n',
      session_id: 'sess-http',
      source: 'test',
    });
    saveSessionHandoff(home, 'default', {
      version: 1,
      sessionId: 'sess-http',
      summary: 'h',
      nextAction: 'na',
      artifacts: [],
    });
    appendSessionEvent(home, 'default', {
      session_id: 'sess-http',
      event_type: 'note',
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
    expect(body.continuityTokens).toBeGreaterThan(0);

    const blank = await fetch(`${handle.url}/v1/memories?q=deploys&include_continuity=true&fresh_tail_session_id=&session_id=%20%20`);
    expect(blank.status).toBe(200);
    expect(blank.headers.get('cache-control')).toBe('no-store');
  });

  it('default-deny scope: private snapshot does NOT leak via HTTP', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'Private HTTP task',
      summary: 'P',
      next_step: 'P',
      session_id: 'sess-private',
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
      next_step: 'P',
      session_id: 'sess-private',
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
