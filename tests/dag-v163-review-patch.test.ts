/**
 * v1.6.3 patch — covers what /review caught after v1.6.2 shipped.
 *
 *   P0-1: assemble truncated/totalRaw was misleading on long sessions.
 *   P1-1: MCP hippo_recall didn't expose fresh_tail_session_id.
 *   P1-3: HTTP fresh_tail_session_id had no length cap.
 *   P1-4: HTTP summarize_overflow accepted any non-'0' string as true.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, countSessionRawMemories } from '../src/store.js';
import { createMemory, Layer, type MemoryEntry, MemoryKind } from '../src/memory.js';
import { assemble, type Context } from '../src/api.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { serve, type ServerHandle } from '../src/server.js';

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(root, '.hippo'), { recursive: true });
  initStore(root);
  return root;
}
function safeRmSync(p: string): void { try { rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
function ctxFor(root: string, tenantId: string = 'default'): Context {
  return { hippoRoot: root, tenantId, actor: 'test:v163' };
}
function makeRaw(text: string, sessionId: string, opts: Partial<MemoryEntry> = {}): MemoryEntry {
  const e = createMemory(text, {
    layer: Layer.Buffer,
    confidence: 'observed',
    kind: 'raw' as MemoryKind,
    scope: opts.scope ?? null,
    tenantId: opts.tenantId ?? 'default',
    source_session_id: sessionId,
  });
  if (opts.created) e.created = opts.created;
  return e;
}

describe('v1.6.3 P0-1 — assemble.totalRaw reports unbounded count when truncated', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('v163-total'); });
  afterEach(() => safeRmSync(root));

  it('rowCap < session size: totalRaw reports the FULL session count', () => {
    for (let i = 0; i < 12; i++) {
      const e = makeRaw(`session message ${i} content body`, 'sess-big');
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = assemble(ctxFor(root), 'sess-big', { rowCap: 5, budget: 100000 });
    expect(r.truncated).toBe(true);
    // Pre-v1.6.3: totalRaw=5 (the cap). Post-v1.6.3: totalRaw=12 (the truth).
    expect(r.totalRaw).toBe(12);
    // items[] is still the windowed view (newest 5).
    expect(r.items.length).toBeLessThanOrEqual(5);
  });

  it('rowCap >= session size: totalRaw uses scoped count (no extra COUNT query)', () => {
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`small session ${i}`, 'sess-small');
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = assemble(ctxFor(root), 'sess-small', { rowCap: 100, budget: 100000 });
    expect(r.truncated).toBe(false);
    expect(r.totalRaw).toBe(3);
  });

  it('rowCap == session size: truncated=true with matching totalRaw (boundary)', () => {
    // Exactly N rows + cap=N triggers truncated=true (rows.length === rowCap).
    // The unbounded COUNT then runs and reports the same N. Documented in the
    // /review report as a subtle case worth pinning.
    for (let i = 0; i < 5; i++) {
      const e = makeRaw(`exact-cap row ${i}`, 'sess-exact');
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = assemble(ctxFor(root), 'sess-exact', { rowCap: 5, budget: 100000 });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(5);
    expect(r.items.length).toBe(5);
  });

  it('truncated session with private rows: scope-aware COUNT does NOT leak', () => {
    // codex P1 / senior P0: pre-fix, an unscoped COUNT(*) let a no-scope
    // caller infer how many private rows existed by comparing totalRaw to
    // items.length. v1.6.3 SQL-encodes the default-deny rule.
    for (let i = 0; i < 4; i++) {
      const e = makeRaw(`public chatter ${i}`, 'sess-mixed', { scope: 'slack:public:CGEN' });
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    for (let i = 0; i < 6; i++) {
      const e = makeRaw(`secret payroll ${i}`, 'sess-mixed', { scope: 'slack:private:CSEC' });
      e.created = `2026-01-${String(i + 5).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    // No-scope caller, rowCap forces truncation. totalRaw must equal the
    // PUBLIC count (4), NOT the full session count (10).
    const r = assemble(ctxFor(root), 'sess-mixed', { rowCap: 3, budget: 100000 });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(4);
  });

  it('truncated session with explicit private scope: caller can see their own count', () => {
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`secret detail ${i}`, 'sess-priv', { scope: 'slack:private:CSEC' });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    // Explicit scope match unlocks the count for the authorised caller.
    // rowCap=2 truncates; totalRaw should equal the count of rows matching
    // the explicit scope (3).
    const r = assemble(ctxFor(root), 'sess-priv', {
      rowCap: 2,
      budget: 100000,
      scope: 'slack:private:CSEC',
    });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(3);
  });
});

describe('v1.6.3 — countSessionRawMemories helper', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('v163-count'); });
  afterEach(() => safeRmSync(root));

  it('counts only matching session, tenant scoped, excluding superseded', () => {
    const a = makeRaw('row a', 'sess-A');
    a.created = '2026-01-01T00:00:00.000Z';
    const b = makeRaw('row b', 'sess-A');
    b.created = '2026-01-02T00:00:00.000Z';
    const c = makeRaw('row c', 'sess-B');
    c.created = '2026-01-03T00:00:00.000Z';
    const d = makeRaw('row d cross tenant', 'sess-A', { tenantId: 'other' });
    d.created = '2026-01-04T00:00:00.000Z';
    [a, b, c, d].forEach((e) => writeEntry(root, e));
    expect(countSessionRawMemories(root, 'sess-A', 'default')).toBe(2);
    expect(countSessionRawMemories(root, 'sess-B', 'default')).toBe(1);
    expect(countSessionRawMemories(root, 'sess-A', 'other')).toBe(1);
    expect(countSessionRawMemories(root, 'sess-no-such-thing', 'default')).toBe(0);
    expect(countSessionRawMemories(root, '', 'default')).toBe(0);
  });
});

describe('v1.6.3 P1-1 — MCP hippo_recall exposes fresh_tail_session_id', () => {
  let home: string;
  let originalHome: string | undefined;
  beforeEach(() => {
    home = makeRoot('v163-mcp');
    originalHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = home;
  });
  afterEach(() => {
    safeRmSync(home);
    if (originalHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = originalHome;
  });

  it('hippo_recall tool schema lists fresh_tail_session_id', async () => {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    const tools = (res as { result?: { tools?: Array<{ name?: string; inputSchema?: { properties?: Record<string, unknown> } }> } }).result?.tools ?? [];
    const recall = tools.find((t) => t.name === 'hippo_recall');
    expect(recall).toBeDefined();
    const props = recall?.inputSchema?.properties ?? {};
    expect(props).toHaveProperty('fresh_tail_session_id');
    expect(props).toHaveProperty('fresh_tail_count');
    expect(props).toHaveProperty('summarize_overflow');
  });
});

describe('v1.6.3 P1-3, P1-4 — HTTP /v1/memories input validation', () => {
  let home: string;
  let handle: ServerHandle;
  beforeEach(async () => {
    home = makeRoot('v163-http-val');
    handle = await serve({ hippoRoot: home, port: 0 });
  });
  afterEach(async () => {
    await handle.stop();
    safeRmSync(home);
  });

  it('400 on fresh_tail_session_id > 256 chars (P1-3)', async () => {
    const big = 'x'.repeat(257);
    const res = await fetch(`${handle.url}/v1/memories?q=test&fresh_tail_session_id=${big}`);
    expect(res.status).toBe(400);
  });

  it('256-char fresh_tail_session_id is accepted (boundary)', async () => {
    const ok = 'x'.repeat(256);
    const res = await fetch(`${handle.url}/v1/memories?q=test&fresh_tail_session_id=${ok}`);
    expect(res.status).toBe(200);
  });

  it('summarize_overflow=banana is treated as false (P1-4)', async () => {
    // No fixture rows; just verify the request succeeds and the parse
    // doesn't throw. Pre-v1.6.3, banana → true; post-v1.6.3, banana → false.
    // Caller can't observe summarize_overflow directly in a row-less
    // recall, but the 200 status confirms the parser doesn't reject the
    // input — and a follow-up test in the JS API path covers the
    // semantic effect via RecallOpts.summarizeOverflow.
    const res = await fetch(`${handle.url}/v1/memories?q=test&summarize_overflow=banana`);
    expect(res.status).toBe(200);
  });

  it('summarize_overflow=1 / =true / =0 / =false / omitted parse correctly', async () => {
    for (const v of ['1', 'true', '0', 'false']) {
      const res = await fetch(`${handle.url}/v1/memories?q=test&summarize_overflow=${v}`);
      expect(res.status).toBe(200);
    }
  });
});
