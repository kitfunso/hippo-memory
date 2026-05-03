import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  appendSessionEvent,
  writeEntry,
} from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-cont-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(home, { recursive: true, force: true });
});

describe('GET /v1/memories continuity + scope', () => {
  it('default: no continuity, no Cache-Control: no-store', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
    const res = await fetch(`${handle.url}/v1/memories?q=deploys`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).not.toBe('no-store');
    const body = await res.json() as { continuity?: unknown; results: unknown[] };
    expect(body.continuity).toBeUndefined();
  });

  it('include_continuity=1: returns continuity block with no-store cache header', async () => {
    writeEntry(home, createMemory('memory about deploys', {}));
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
    const body = await res.json() as {
      continuity?: { activeSnapshot?: { task: string } | null };
      continuityTokens?: number;
    };
    expect(body.continuity?.activeSnapshot?.task).toBe('HTTP continuity');
    expect(body.continuityTokens).toBeGreaterThan(0);
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
    const body = await res.json() as {
      continuity?: { activeSnapshot?: { task: string } | null };
    };
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
    const body = await res.json() as {
      continuity?: { activeSnapshot?: { task: string } | null };
    };
    expect(body.continuity?.activeSnapshot?.task).toBe('Private HTTP task');
  });
});
