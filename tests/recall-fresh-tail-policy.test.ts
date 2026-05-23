/**
 * F5 (v1.6.5) — typed RecallContractError thrown from `api.recall` when the
 * deployment opts in via HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL=1 and the
 * caller asks for fresh-tail without a session id.
 *
 * Default behaviour (env unset) preserves v1.6.x back-compat: tenant-wide
 * rows are returned and tagged isFreshTail=true. Guard lives only in
 * api.recall — api.assemble is already session-scoped via
 * loadSessionRawMemories and never calls tenant-wide loadFreshRawMemories.
 *
 * No library `console.warn` introduced anywhere — codex C9 said library
 * stderr noise is bad behaviour; enforcement is only at the API boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry, MemoryKind } from '../src/memory.js';
import { recall, RecallContractError, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: { subject: 'test:f5-policy', role: 'admin' } };
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    tags: opts.tags ?? [],
    source_session_id: opts.source_session_id ?? null,
  });
}

describe('fresh-tail policy F5 (v1.6.5)', () => {
  let root: string;
  // Snapshot + restore env so other test files are not affected.
  let prevEnv: string | undefined;

  beforeEach(() => {
    root = makeRoot('f5');
    prevEnv = process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
    delete process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
  });
  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
    } else {
      process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = prevEnv;
    }
    safeRmSync(root);
  });

  it('back-compat: env unset, freshTailCount > 0, no sessionId → tenant-wide rows, no throw', () => {
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`event ${i}`));
    expect(() =>
      recall(ctxFor(root), { query: 'event', freshTailCount: 3 }),
    ).not.toThrow();
    const r = recall(ctxFor(root), { query: 'event', freshTailCount: 3 });
    // At least one row should be tagged isFreshTail under tenant-wide policy.
    expect(r.results.some((it) => it.isFreshTail === true)).toBe(true);
  });

  it('env=1, freshTailCount > 0, no sessionId → throws RecallContractError with code', () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`event ${i}`));
    let thrown: unknown = null;
    try {
      recall(ctxFor(root), { query: 'event', freshTailCount: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallContractError);
    expect((thrown as RecallContractError).code).toBe(
      'fresh_tail_requires_session_id',
    );
    expect((thrown as RecallContractError).message).toContain(
      'HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL',
    );
  });

  it('env=1, freshTailSessionId set → no throw, session-scoped rows surface', () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    const sess = 'sess-A';
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`session A event ${i}`, { source_session_id: sess });
      writeEntry(root, e);
    }
    // Different session — should NOT surface as fresh-tail.
    for (let i = 0; i < 2; i++) {
      const e = makeRaw(`session B event ${i}`, { source_session_id: 'sess-B' });
      writeEntry(root, e);
    }
    const r = recall(ctxFor(root), {
      query: 'session',
      freshTailCount: 5,
      freshTailSessionId: sess,
    });
    const freshIds = r.results.filter((it) => it.isFreshTail).map((it) => it.id);
    // Every fresh-tail row must come from sess-A.
    expect(freshIds.length).toBeGreaterThan(0);
    // And no fresh-tail row should mention "session B".
    for (const it of r.results) {
      if (it.isFreshTail) {
        expect(it.content).not.toContain('session B');
      }
    }
  });

  it('env=1, freshTailCount=0 (or unset) → no throw (guard fires only when fresh-tail requested)', () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`event ${i}`));
    expect(() => recall(ctxFor(root), { query: 'event' })).not.toThrow();
    expect(() =>
      recall(ctxFor(root), { query: 'event', freshTailCount: 0 }),
    ).not.toThrow();
  });

  it('env=anything-other-than-"1" → treated as unset, no throw', () => {
    // Stricter than truthy: only the literal string "1" enables the guard.
    // Defensive against env values like "true" / "yes" / "0" that callers
    // might set expecting "any truthy" semantics.
    for (const val of ['true', 'yes', '0', '', 'false']) {
      process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = val;
      for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`v-${val}-event ${i}`));
      expect(() =>
        recall(ctxFor(root), { query: 'event', freshTailCount: 3 }),
      ).not.toThrow();
    }
  });
});
