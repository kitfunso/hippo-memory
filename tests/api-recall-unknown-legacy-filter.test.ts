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
  return { hippoRoot: root, tenantId: 'default', actor: { subject: 'test:legacy', role: 'admin' } };
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

  it('unscoped recall does NOT surface scope=unknown:legacy rows (also excludes private:*)', () => {
    writeEntry(root, makeWithScope('public-row alpha', null));
    writeEntry(root, makeWithScope('legacy-row alpha', 'unknown:legacy'));
    // Pin private-scope filter alongside legacy filter so this becomes the
    // canonical unscoped default-deny test (covers SQL legacy exclusion +
    // JS private-scope exclusion).
    writeEntry(root, makeWithScope('private-row alpha', 'slack:private:Cabc'));

    const r = recall(ctxFor(root), { query: 'alpha' });
    const contents = r.results.map((it) => it.content);
    expect(contents).toContain('public-row alpha');
    expect(contents).not.toContain('legacy-row alpha');
    expect(contents).not.toContain('private-row alpha');
    // Exactly one row surfaces.
    expect(r.results.length).toBe(1);
  });

  it('explicit scope=unknown:legacy DOES surface the row (operator opt-in for the quarantine bucket)', () => {
    // The SQL exact-match branch in loadSearchRows must still admit
    // `m.scope = 'unknown:legacy'` when the caller asks for it. A regression
    // that hardcoded `scope != 'unknown:legacy'` in BOTH SQL branches would
    // pass the unscoped test but fail this one.
    writeEntry(root, makeWithScope('legacy-row beta', 'unknown:legacy'));
    writeEntry(root, makeWithScope('public-row beta', null));

    const r = recall(ctxFor(root), { query: 'beta', scope: 'unknown:legacy' });
    const contents = r.results.map((it) => it.content);
    expect(contents).toContain('legacy-row beta');
    expect(contents).not.toContain('public-row beta');
    expect(r.results.length).toBe(1);
  });

  it('empty-string scope is treated as unset (default-deny mode)', () => {
    // codex P1[4]: pin the empty-string semantics. `loadRecallSearchEntries`
    // collapses '' → null (default-deny); api.ts treats '' as unset (private
    // filter applies). Both sides must agree or surfaces drift.
    writeEntry(root, makeWithScope('public-row gamma', null));
    writeEntry(root, makeWithScope('legacy-row gamma', 'unknown:legacy'));

    const r = recall(ctxFor(root), { query: 'gamma', scope: '' });
    const contents = r.results.map((it) => it.content);
    expect(contents).toContain('public-row gamma');
    expect(contents).not.toContain('legacy-row gamma');
  });
});
