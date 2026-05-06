/**
 * v1.7.1 (codex finding from v1.6.5 review) — unknown:legacy rows must NOT
 * surface in `recall()` baseRanked when caller passes no scope.
 *
 * `passesScopeFilterForRecall` (src/api.ts:120) documents the contract:
 * default-deny on private:* AND on 'unknown:legacy' (the quarantine bucket).
 * Continuity, drillDown, assemble already honour it. The BM25 base path at
 * src/api.ts:393 only filtered isPrivateScope, missing 'unknown:legacy'.
 *
 * v1.7.1 fixes this at the producer: SQL predicate in loadSearchRows via
 * a new loadRecallSearchEntries helper. Test fires red on master, green
 * after the producer-layer fix.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind, type MemoryEntry } from '../src/memory.js';
import { recall, type Context } from '../src/api.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void {
  try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
}
function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: 'test:legacy' };
}
function makeWithScope(text: string, scope: string | null): MemoryEntry {
  return createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    scope,
    tenantId: 'default',
  });
}

describe('recall: default-deny on unknown:legacy (v1.7.1)', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('unknown-legacy'); });
  afterEach(() => safeRmSync(root));

  it('unscoped recall does NOT surface scope=unknown:legacy rows', () => {
    writeEntry(root, makeWithScope('public-row alpha', null));
    writeEntry(root, makeWithScope('legacy-row alpha', 'unknown:legacy'));

    const r = recall(ctxFor(root), { query: 'alpha' });
    const contents = r.results.map((it) => it.content);
    expect(contents).toContain('public-row alpha');
    expect(contents).not.toContain('legacy-row alpha');
  });
});
