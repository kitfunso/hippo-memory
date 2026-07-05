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
import { initStore, saveActiveTaskSnapshot, writeEntry } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { remember } from '../src/api.js';
import { createMemory } from '../src/memory.js';
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
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
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
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    for (let i = 0; i < 10; i++) {
      remember(ctx, { content: `padding ${'x'.repeat(200)} content ${i}` });
    }

    const res = await fetch(`${handle.url}/v1/context?budget=50`);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: unknown[]; tokens: number };
    expect(body.tokens).toBeLessThanOrEqual(50);
  });

  it('v39 origin partition at the HTTP surface: default excludes cross-project rows, cross_project=1 re-includes', async () => {
    // The route derives the partition identity from the SERVED STORE's parent
    // (server.ts /v1/context: resolveProjectIdentity(dirname(hippoRoot))), so
    // this test serves a project-shaped store <tmp>/proj-a/.hippo — the
    // outer describe's bare-tmpdir store resolves to a NON-project session
    // ('' identity), which admits everything by design (pre-v39 parity).
    const isoTmp = mkdtempSync(join(tmpdir(), 'hippo-srv-iso-'));
    const projHippo = join(isoTmp, 'proj-a', '.hippo');
    mkdirSync(projHippo, { recursive: true });
    initStore(projHippo);
    const projHandle = await serve({ hippoRoot: projHippo, port: 0 });
    try {
      const ctx = { hippoRoot: projHippo, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
      remember(ctx, { content: 'ownrow deploykey local fact' });
      // Cross-project row in the GLOBAL store (the 2026-07-01 leak shape).
      writeEntry(globalHome, {
        ...createMemory('BRAVO deploykey cross-project fact', { pinned: true }),
        origin_project: 'proj-b',
      });

      const contents = async (qs: string): Promise<string> => {
        const res = await fetch(`${projHandle.url}/v1/context?${qs}`);
        expect(res.status).toBe(200);
        const body = await res.json() as { entries: Array<{ entry: { content: string } }> };
        return body.entries.map((e) => e.entry.content).join('\n');
      };

      const byDefault = await contents('q=deploykey');
      expect(byDefault).toContain('ownrow deploykey local fact');
      expect(byDefault).not.toContain('BRAVO deploykey cross-project fact');

      const withCross = await contents('q=deploykey&cross_project=1');
      expect(withCross).toContain('BRAVO deploykey cross-project fact');
    } finally {
      await projHandle.stop();
      rmSync(isoTmp, { recursive: true, force: true });
    }
  });

  it('v39 secret veto at the HTTP surface: secret rows never inject, even with cross_project=1', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    remember(ctx, { content: 'harmless deploykey row' });
    // Secret-bearing rows: one cross-project, one with no origin — neither
    // may ambient-inject regardless of the cross_project override.
    writeEntry(globalHome, {
      ...createMemory('deploykey secret sk_vendor_deadbeef123456 from proj-b', { pinned: true }),
      origin_project: 'proj-b',
    });
    writeEntry(globalHome, {
      ...createMemory('deploykey secret sk_vendor_feedface654321 no origin', { pinned: true }),
      origin_project: '',
    });

    for (const qs of ['q=deploykey', 'q=deploykey&cross_project=1']) {
      const res = await fetch(`${handle.url}/v1/context?${qs}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { entries: Array<{ entry: { content: string } }> };
      const text = body.entries.map((e) => e.entry.content).join('\n');
      expect(text).not.toContain('sk_vendor_deadbeef123456');
      expect(text).not.toContain('sk_vendor_feedface654321');
    }
  });

  it('budget=0 short-circuits to empty result', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
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
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
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
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
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
    const ctxA = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    const ctxB = { hippoRoot: home, tenantId: 'tenant_b', actor: { subject: 'localhost:cli', role: 'admin' } };
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

  // v1.11.5: DoS cap on q-param + recall-audit-row HTTP test
  it('q exceeding 1024 chars returns 400', async () => {
    const q = 'a'.repeat(1025);
    const res = await fetch(`${handle.url}/v1/context?q=${q}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('1024-character cap');
  });

  it('q at 1024-char boundary returns 200', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    remember(ctx, { content: 'boundary-test' });
    const q = 'a'.repeat(1024);
    const res = await fetch(`${handle.url}/v1/context?q=${q}`);
    expect(res.status).toBe(200);
  });

  it('q=foo emits exactly one recall audit row (row-count delta)', async () => {
    const ctx = { hippoRoot: home, tenantId: 'default', actor: { subject: 'localhost:cli', role: 'admin' } };
    remember(ctx, { content: 'foo bar baz' });
    remember(ctx, { content: 'foo qux' });
    remember(ctx, { content: 'unrelated content' });

    // Snapshot audit_log count BEFORE the request.
    const db1 = openHippoDb(home);
    const before = queryAuditEvents(db1, { tenantId: 'default', op: 'recall' });
    closeHippoDb(db1);

    const res = await fetch(`${handle.url}/v1/context?q=foo&budget=1000`);
    expect(res.status).toBe(200);

    // Assert EXACTLY one new 'recall' row from THIS request.
    const db2 = openHippoDb(home);
    const after = queryAuditEvents(db2, { tenantId: 'default', op: 'recall' });
    closeHippoDb(db2);
    expect(after.length).toBe(before.length + 1);
  });
});
