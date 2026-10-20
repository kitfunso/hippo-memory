/**
 * v1.6.1 patch — covers the senior-review P1 holes that v1.6.0 shipped.
 *
 *   #1 loadSessionRawMemories row cap → AssembleResult.truncated
 *   #2 totalRaw is now POST-scope-filter
 *   #3 AssembleOptions.scope parity with recall (authorised access to private)
 */

import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory, Layer, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { assemble } from '../../src/api/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { loadSessionRawMemories, writeEntry } from '../_helpers/root-forms.js';

function safeRmSync(p: string): void {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
function ctxFor(root: string, tenantId: string = 'default'): FullContext {
  return apiCtx(root, tenantId, { subject: 'test:assemble-v161', role: 'admin' });
}
function makeRaw(text: string, sessionId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw',
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    sourceSessionId: sessionId,
  });
  if (opts.created) e.created = opts.created;
  return e;
}

describe('loadSessionRawMemories row cap', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v161-cap');
  });
  afterEach(() => safeRmSync(root));

  it('cap=undefined returns every row (legacy behaviour)', () => {
    for (let i = 0; i < 12; i++) {
      const e = makeRaw(`message body row number ${i}`, 'sess-x');
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    expect(loadSessionRawMemories(root, 'sess-x', 'default').length).toBe(12);
  });
});

describe('totalRaw is post-scope', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v161-total');
  });
  afterEach(() => safeRmSync(root));

  it('all-private session: totalRaw=0, items=[], no false positive', async () => {
    for (let i = 0; i < 4; i++) {
      const e = makeRaw(`secret content ${i}`, 'sess-p', { scope: 'slack:private:CSEC' });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    // No scope passed → default-deny.
    const r = await assemble(ctxFor(root), 'sess-p');
    expect(r.totalRaw).toBe(0);
    expect(r.items).toEqual([]);
  });

  it('mixed public + private session: totalRaw counts only public', async () => {
    const pub = makeRaw('public content', 'sess-m', { scope: 'slack:public:CGEN' });
    pub.created = '2026-01-01T00:00:00.000Z';
    const priv = makeRaw('private content', 'sess-m', { scope: 'slack:private:CSEC' });
    priv.created = '2026-01-02T00:00:00.000Z';
    writeEntry(root, pub);
    writeEntry(root, priv);
    const r = await assemble(ctxFor(root), 'sess-m');
    expect(r.totalRaw).toBe(1);
    expect(r.items.map((it) => it.id)).toEqual([pub.id]);
  });
});

describe('assemble scope opt parity with recall', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v161-scope');
  });
  afterEach(() => safeRmSync(root));

  it('explicit scope match unlocks a private session', async () => {
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`secret detail ${i}`, 'sess-priv', {
        scope: 'slack:private:CSEC',
      });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    // Without scope: blocked.
    const blocked = await assemble(ctxFor(root), 'sess-priv');
    expect(blocked.items).toEqual([]);
    // With matching scope: unlocked.
    const unlocked = await assemble(ctxFor(root), 'sess-priv', { scope: 'slack:private:CSEC' });
    expect(unlocked.items.length).toBe(3);
    expect(unlocked.totalRaw).toBe(3);
  });

  it('explicit scope mismatch returns empty', async () => {
    const e = makeRaw('private content', 'sess-m', { scope: 'slack:private:CSEC' });
    writeEntry(root, e);
    const r = await assemble(ctxFor(root), 'sess-m', { scope: 'slack:private:CDIFFERENT' });
    expect(r.items).toEqual([]);
  });
});
