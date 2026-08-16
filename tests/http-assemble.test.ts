/**
 * HTTP `GET /v1/sessions/:id/assemble` — surface check for Phase 2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';
import { serve, type ServerHandle } from '../src/server.js';

async function jsonAs<T>(res: Response): Promise<T> {
  // SAFETY: every call site awaits a `fetch()` response from the local test server started
  // in this file's `beforeEach`, whose route handlers are exercised directly below.
  return (await res.json()) as T;
}

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-assemble-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }

let home: string;
let handle: ServerHandle;

beforeEach(async () => {
  home = makeRoot();
  handle = await serve({ hippoRoot: home, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  safeRmSync(home);
});

describe('GET /v1/sessions/:id/assemble', () => {
  it('200 with items + counts for a real session', async () => {
    for (let i = 0; i < 4; i++) {
      const e = createMemory(`http session message ${i}`, {
        layer: Layer.Buffer,
        confidence: 'observed',
        kind: 'raw',
        source_session_id: 'sess-http',
        tenantId: 'default',
      });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(home, e);
    }
    const res = await fetch(`${handle.url}/v1/sessions/sess-http/assemble`);
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      sessionId: string;
      items: Array<{ id: string; content: string; isFreshTail?: boolean }>;
      totalRaw: number;
    }>(res);
    expect(body.sessionId).toBe('sess-http');
    expect(body.totalRaw).toBe(4);
    expect(body.items.length).toBe(4);
  });

  it('200 with empty items for unknown session', async () => {
    const res = await fetch(`${handle.url}/v1/sessions/sess-nope/assemble`);
    expect(res.status).toBe(200);
    const body = await jsonAs<{ items: unknown[]; totalRaw: number }>(res);
    expect(body.items).toEqual([]);
    expect(body.totalRaw).toBe(0);
  });

  it('400 on bad budget', async () => {
    const res = await fetch(`${handle.url}/v1/sessions/sess-x/assemble?budget=0`);
    expect(res.status).toBe(400);
  });

  it('400 on bad freshTail', async () => {
    const res = await fetch(`${handle.url}/v1/sessions/sess-x/assemble?freshTail=-1`);
    expect(res.status).toBe(400);
  });

  it('summarizeOlder=0 disables substitution', async () => {
    // 3 raws under one parent + parent summary. Without summarize: 3 items.
    const summary = createMemory('topic alpha rollup http', {
      layer: Layer.Semantic, dag_level: 2, confidence: 'inferred', tags: ['dag-summary'],
    });
    writeEntry(home, summary);
    for (let i = 0; i < 3; i++) {
      const e = createMemory(`older detail ${i}`, {
        layer: Layer.Episodic,
        confidence: 'observed',
        kind: 'raw',
        source_session_id: 'sess-noop',
        dag_level: 1,
        dag_parent_id: summary.id,
        tenantId: 'default',
      });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(home, e);
    }
    const res = await fetch(`${handle.url}/v1/sessions/sess-noop/assemble?summarizeOlder=0&freshTail=1`);
    const body = await jsonAs<{
      summarized: number;
      items: Array<{ isSummary?: boolean }>;
    }>(res);
    expect(body.summarized).toBe(0);
    expect(body.items.every((it) => !it.isSummary)).toBe(true);
  });
});
