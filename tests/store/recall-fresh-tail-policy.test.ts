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

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { retrieve, RecallContractError } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { writeEntry } from '../_helpers/root-forms.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:f5-policy', role: 'admin' });
}
function makeRaw(text: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    scope: opts.scope ?? null,
    tenantId: opts.tenant_id ?? 'default',
    tags: opts.tags ?? [],
    sourceSessionId: opts.source_session_id ?? null,
  });
}

describe('fresh-tail policy', () => {
  let root: string;

  beforeEach(() => {
    root = makeRoot('f5');
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', undefined);
  });
  afterEach(() => {
    safeRmSync(root);
  });

  it('back-compat: env unset, freshTailCount > 0, no sessionId → tenant-wide rows, no throw', async () => {
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`event ${i}`));
    const r = await retrieve(ctxFor(root), { query: 'event', window: { freshTailCount: 3 } });
    // Tenant-wide policy: the three raw rows come back, and at least one is tagged isFreshTail.
    expect(r.results).toHaveLength(3);
    expect(r.results.some((it) => it.isFreshTail === true)).toBe(true);
  });

  it('env=1, freshTailCount > 0, no sessionId → throws RecallContractError with code', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`event ${i}`));
    let thrown = null;
    try {
      await retrieve(ctxFor(root), { query: 'event', window: { freshTailCount: 3 } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallContractError);
    // SAFETY: the instanceof check above confirms `thrown` is a
    // RecallContractError before either cast reads its fields.
    expect((thrown as RecallContractError).code).toBe('fresh_tail_requires_session_id');
    // SAFETY: same guaranteed RecallContractError instance as above.
    expect((thrown as RecallContractError).message).toContain('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL');
  });

  it('env=1, freshTailSessionId set → no throw, session-scoped rows surface', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
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
    const r = await retrieve(ctxFor(root), {
      query: 'session',
      window: { freshTailCount: 5, freshTailSessionId: sess },
    });
    const fresh = r.results
      .filter((it) => it.isFreshTail)
      .map((it) => it.content)
      .sort();
    // Every fresh-tail row must come from sess-A, and all three of them surface.
    expect(fresh).toEqual(['session A event 0', 'session A event 1', 'session A event 2']);
    // And no fresh-tail row should mention "session B".
    for (const it of r.results) {
      if (it.isFreshTail) {
        expect(it.content).not.toContain('session B');
      }
    }
  });

  it('env=1, freshTailCount=0 (or unset) → no throw (guard fires only when fresh-tail requested)', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`event ${i}`));
    const unset = await retrieve(ctxFor(root), { query: 'event' });
    const zero = await retrieve(ctxFor(root), { query: 'event', window: { freshTailCount: 0 } });
    for (const r of [unset, zero]) {
      expect(r.results.map((it) => it.content).sort()).toEqual(['event 0', 'event 1', 'event 2']);
      expect(r.results.filter((it) => it.isFreshTail)).toEqual([]);
    }
  });

  it('env=an off or unknown spelling → treated as unset, no throw', async () => {
    // Only the on spellings (1, true, on) enable the guard; "yes" is unknown and takes the off side.
    for (const val of ['yes', '0', '', 'false']) {
      vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', val);
      for (let i = 0; i < 3; i++) writeEntry(root, makeRaw(`v-${val}-event ${i}`));
      const none = await retrieve(ctxFor(root), { query: 'event' });
      expect(none.results.length).toBeGreaterThanOrEqual(3);
      expect(none.results.filter((it) => it.isFreshTail)).toEqual([]);
      // The guard is off, so the newest three raw rows come back tagged, each exactly once.
      const r = await retrieve(ctxFor(root), { query: 'event', window: { freshTailCount: 3 } });
      const tail = r.results.filter((it) => it.isFreshTail);
      expect(tail).toHaveLength(3);
      expect(new Set(tail.map((it) => it.id)).size).toBe(3);
      expect(r.results.filter((it) => it.content.startsWith(`v-${val}-event`) && it.isFreshTail)).toHaveLength(3);
    }
  });
});
