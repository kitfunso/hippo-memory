/**
 * v1.6.4 — error distinguishability + path matcher hardening.
 *
 *   Task 1: drillDown returns discriminated DrillDownOutcome with
 *           failure='not_found' | 'scope_blocked' | 'not_drillable'.
 *           HTTP maps not_drillable → 422; others → 404.
 *   Task 2: pre-match raw-URL %2F rejection + post-match charset
 *           validation on every :id path segment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { drillDown, type Context } from '../src/api.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: 'test:v164' };
}
function makeSummary(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Semantic,
    tags: ['dag-summary'],
    confidence: 'inferred',
    dag_level: 2,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
  });
}

describe('v1.6.4 Task 1 — drillDown discriminated outcome', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('v164-task1'); });
  afterEach(() => safeRmSync(root));

  it('failure=not_found for unknown id', () => {
    const r = drillDown(ctxFor(root), 'mem_no_such_thing');
    expect('failure' in r).toBe(true);
    if ('failure' in r) expect(r.failure).toBe('not_found');
  });

  it('failure=not_found for cross-tenant id (NO unscoped probe leak)', () => {
    const s = makeSummary('other tenant', { tenantId: 'other' });
    writeEntry(root, s);
    const r = drillDown(ctxFor(root, 'default'), s.id);
    expect('failure' in r).toBe(true);
    // Intentionally collapsed; distinguishing would leak existence.
    if ('failure' in r) expect(r.failure).toBe('not_found');
  });

  it('failure=not_drillable for a leaf row', () => {
    const leaf = createMemory('plain leaf body content', {
      layer: Layer.Buffer,
      confidence: 'observed',
      dag_level: 0,
    });
    writeEntry(root, leaf);
    const r = drillDown(ctxFor(root), leaf.id);
    expect('failure' in r).toBe(true);
    if ('failure' in r) expect(r.failure).toBe('not_drillable');
  });

  it('failure=not_found for a private-scoped summary (codex round 3 P1 collapse)', () => {
    // Distinguishable scope_blocked told no-scope callers "row exists but
    // not for you" — same existence leak the HTTP 404 collapse fixed.
    // Now collapsed at the JS API level to match HTTP behaviour.
    const s = makeSummary('secret topic', { scope: 'slack:private:CSEC' });
    writeEntry(root, s);
    const r = drillDown(ctxFor(root), s.id);
    expect('failure' in r).toBe(true);
    if ('failure' in r) expect(r.failure).toBe('not_found');
  });
});

describe('v1.6.4 Task 1 — HTTP /v1/recall/drill status mapping', () => {
  let home: string;
  let handle: ServerHandle;
  beforeEach(async () => {
    home = makeRoot('v164-http');
    handle = await serve({ hippoRoot: home, port: 0 });
  });
  afterEach(async () => {
    await handle.stop();
    safeRmSync(home);
  });

  it('404 for unknown id', async () => {
    const res = await fetch(`${handle.url}/v1/recall/drill/mem_no_such_thing`);
    expect(res.status).toBe(404);
  });

  it('422 for a leaf id (caller-actionable)', async () => {
    const leaf = createMemory('leaf body row content', {
      layer: Layer.Buffer,
      confidence: 'observed',
      dag_level: 0,
    });
    writeEntry(home, leaf);
    const res = await fetch(`${handle.url}/v1/recall/drill/${leaf.id}`);
    expect(res.status).toBe(422);
    // Regression guard: body must contain "leaf" so a future "fix" that
    // collapses the message back to a generic "not found" is caught.
    const body = await res.json() as { error?: string };
    expect((body.error ?? '').toLowerCase()).toContain('leaf');
  });

  it('404 for cross-tenant id (no info leak)', async () => {
    const s = makeSummary('other tenant', { tenantId: 'other' });
    writeEntry(home, s);
    const res = await fetch(`${handle.url}/v1/recall/drill/${s.id}`);
    expect(res.status).toBe(404);
  });

  it('404 for a scope-blocked private summary', async () => {
    const s = makeSummary('private topic', { scope: 'slack:private:CSEC' });
    writeEntry(home, s);
    const res = await fetch(`${handle.url}/v1/recall/drill/${s.id}`);
    expect(res.status).toBe(404);
  });
});

describe('v1.6.4 Task 2 — HTTP path-segment validation', () => {
  let home: string;
  let handle: ServerHandle;
  beforeEach(async () => {
    home = makeRoot('v164-path');
    handle = await serve({ hippoRoot: home, port: 0 });
  });
  afterEach(async () => {
    await handle.stop();
    safeRmSync(home);
  });

  it('400 on URL-encoded slash %2F', async () => {
    const res = await fetch(`${handle.url}/v1/recall/drill/foo%2Fbar`);
    expect(res.status).toBe(400);
  });

  it('400 on lowercase URL-encoded slash %2f', async () => {
    const res = await fetch(`${handle.url}/v1/recall/drill/foo%2fbar`);
    expect(res.status).toBe(400);
  });

  it('400 on illegal charset (semicolon)', async () => {
    // Direct charset hit. The id `foo;bar` has chars outside `[A-Za-z0-9_:.-]`.
    const res = await fetch(`${handle.url}/v1/recall/drill/foo;bar`);
    expect(res.status).toBe(400);
  });

  it('400 on length cap > 256', async () => {
    const big = 'x'.repeat(257);
    const res = await fetch(`${handle.url}/v1/recall/drill/${big}`);
    expect(res.status).toBe(400);
  });

  it('200/404 on length boundary == 256 (charset OK)', async () => {
    // 256 chars passes validateIdSegment; route then 404s because no such row.
    // Important: 256 is the inclusive cap, NOT a 400.
    const ok = 'a'.repeat(256);
    const res = await fetch(`${handle.url}/v1/recall/drill/${ok}`);
    expect(res.status).toBe(404);
  });

  it('200 on a valid id (allowed charset path)', async () => {
    const s = makeSummary('valid id summary');
    writeEntry(home, s);
    const res = await fetch(`${handle.url}/v1/recall/drill/${s.id}`);
    expect(res.status).toBe(200);
  });

  it('400 on /v1/sessions/:id/assemble with %2F in id', async () => {
    const res = await fetch(`${handle.url}/v1/sessions/foo%2Fbar/assemble`);
    expect(res.status).toBe(400);
  });

  it('400 on /v1/memories/:id/archive with illegal charset', async () => {
    const res = await fetch(`${handle.url}/v1/memories/has;semi/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('400 on /v1/auth/keys/:keyId DELETE with illegal charset (caught by /review round 3)', async () => {
    // 7th :id route the plan-stage review missed; final-pass /review caught.
    const res = await fetch(`${handle.url}/v1/auth/keys/has;semi`, { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('200 on /v1/memories with %2F in QUERY string (codex round 3 P2)', async () => {
    // Pre-codex-round-3 rejectEncodedSlash scanned the full URL including
    // query, so any recall query containing a URL would 400. Splitting
    // on the first `?` confines the check to the pathname.
    const res = await fetch(`${handle.url}/v1/memories?q=https%3A%2F%2Fexample.com`);
    expect(res.status).toBe(200);
  });
});
