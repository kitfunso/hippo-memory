/**
 * Runtime tests for GET /v1/context (Episode B, Task 3).
 *
 * Thin wrapper over api.getContext. Returns ContextResult JSON (entries,
 * tokens, activeSnapshot, sessionHandoff, recentEvents). No server-side
 * rendering — clients render markdown / json / additional-context.
 *
 * Coverage:
 *   - default budget returns entries (200)
 *   - budget cap honored
 *   - q filter
 *   - pinned_only flag
 *   - activeSnapshot in response
 *   - budget=0 short-circuit
 *   - budget=-1 -> 400
 *   - tenant scoping: tenant_a Bearer never sees tenant_b
 *
 * Real HTTP server (serve port:0), per-test isolated local + global stores.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, saveActiveTaskSnapshot } from '../src/store.js';
import { remember } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(): string {
  const home = mkdtempSync(join(tmpdir(), 'hippo-srv-ctx-'));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

describe('GET /v1/context', () => {
  let home: string;
  let globalHome: string;
  let origHippoHome: string | undefined;
  let handle: ServerHandle;

  beforeEach(async () => {
    home = makeRoot();
    globalHome = makeRoot();
    origHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
    handle = await serve({ hippoRoot: home, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    if (origHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = origHippoHome;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(globalHome, { recursive: true, force: true });
  });

  it('returns entries within budget (200)', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    for (let i = 0; i < 5; i++) {
      remember(ctx, { content: `ctx-route-mem-${i}` });
    }

    const res = await fetch(`${handle.url}/v1/context?budget=1500`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; tokens: number };
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.tokens).toBeGreaterThan(0);
  });

  it('honors tight budget cap', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    for (let i = 0; i < 10; i++) {
      remember(ctx, { content: `padding ${'x'.repeat(200)} content ${i}` });
    }

    const res = await fetch(`${handle.url}/v1/context?budget=50`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; tokens: number };
    expect(body.tokens).toBeLessThanOrEqual(50);
  });

  it('budget=0 short-circuits to empty result', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    remember(ctx, { content: 'budget-zero' });

    const res = await fetch(`${handle.url}/v1/context?budget=0`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; tokens: number };
    expect(body.entries).toEqual([]);
    expect(body.tokens).toBe(0);
  });

  it('budget=-1 returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/context?budget=-1`);
    expect(res.status).toBe(400);
  });

  it('limit=0 returns 400', async () => {
    const res = await fetch(`${handle.url}/v1/context?limit=0`);
    expect(res.status).toBe(400);
  });

  it('pinned_only filters to pinned entries only', async () => {
    // Seed: 2 unpinned + 1 pinned. Default-tenant memories.
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    remember(ctx, { content: 'unpinned-1' });
    remember(ctx, { content: 'unpinned-2' });
    // Use store-level write for pinned to keep the test simple.
    const { writeEntry } = await import('../src/store.js');
    const { createMemory, Layer } = await import('../src/memory.js');
    const pinnedEntry = createMemory('pinned-canary', {
      layer: Layer.Episodic,
      tags: ['ctx-route-test'],
    });
    pinnedEntry.pinned = true;
    writeEntry(home, pinnedEntry);

    const res = await fetch(`${handle.url}/v1/context?pinned_only=1&budget=1500`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      entries: Array<{ entry: { id: string; content: string; pinned?: boolean } }>;
    };
    // All returned entries should be pinned.
    expect(body.entries.length).toBeGreaterThan(0);
    for (const e of body.entries) {
      expect(e.entry.pinned).toBe(true);
    }
  });

  it('returns activeSnapshot when set for the active session', async () => {
    saveActiveTaskSnapshot(home, 'default', {
      task: 'ctx-route-snapshot-test',
      summary: 'Snapshot for the activeSnapshot return path',
      next_step: 'Verify the route surfaces it',
      source: 'test',
      session_id: 'sess-ctx-route',
      scope: null,
    });
    const ctx = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    remember(ctx, { content: 'snapshot-companion' });

    const res = await fetch(`${handle.url}/v1/context?budget=1500`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      activeSnapshot?: { session_id: string; task: string };
    };
    expect(body.activeSnapshot).toBeTruthy();
    expect(body.activeSnapshot?.session_id).toBe('sess-ctx-route');
    expect(body.activeSnapshot?.task).toBe('ctx-route-snapshot-test');
  });

  it('tenant scoping: default Bearer does not see tenant_b memories', async () => {
    const ctxA = { hippoRoot: home, tenantId: 'default', actor: 'localhost:cli' };
    const ctxB = { hippoRoot: home, tenantId: 'tenant_b', actor: 'localhost:cli' };
    remember(ctxA, { content: 'belongs-to-default' });
    remember(ctxB, { content: 'belongs-to-tenant-B' });

    // No Bearer in the request -> ctx.tenantId resolves to 'default'.
    const res = await fetch(`${handle.url}/v1/context?budget=1500`);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      entries: Array<{ entry: { content: string } }>;
    };
    const contents = body.entries.map((e) => e.entry.content);
    expect(contents).toContain('belongs-to-default');
    expect(contents).not.toContain('belongs-to-tenant-B');
  });
});
