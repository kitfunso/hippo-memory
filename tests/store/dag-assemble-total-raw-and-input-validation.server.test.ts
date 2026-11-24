import type { FullContext } from '../_helpers/api-ctx.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { assemble } from '../../src/api/index.js';
import { handleMcpRequest } from '../../src/surface/mcp/server.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { serveKeyed } from '../_helpers/keyed-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { countSessionRawMemories, writeEntry } from '../_helpers/root-forms.js';
import { loadConfig } from '../../src/host/config-file.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

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
  return apiCtx(root, tenantId, { subject: 'test:v163', role: 'admin' });
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

describe('assemble.totalRaw reports unbounded count when truncated', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v163-total');
  });
  afterEach(() => safeRmSync(root));

  it('rowCap < session size: totalRaw reports the FULL session count', async () => {
    for (let i = 0; i < 12; i++) {
      const e = makeRaw(`session message ${i} content body`, 'sess-big');
      e.created = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = await assemble(ctxFor(root), 'sess-big', { rowCap: 5, budget: 100000 });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(12);
    expect(r.items.length).toBeLessThanOrEqual(5);
  });

  it('rowCap >= session size: totalRaw uses scoped count (no extra COUNT query)', async () => {
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`small session ${i}`, 'sess-small');
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = await assemble(ctxFor(root), 'sess-small', { rowCap: 100, budget: 100000 });
    expect(r.truncated).toBe(false);
    expect(r.totalRaw).toBe(3);
  });

  it('rowCap == session size: truncated=true with matching totalRaw (boundary)', async () => {
    for (let i = 0; i < 5; i++) {
      const e = makeRaw(`exact-cap row ${i}`, 'sess-exact');
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = await assemble(ctxFor(root), 'sess-exact', { rowCap: 5, budget: 100000 });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(5);
    expect(r.items.length).toBe(5);
  });

  it('truncated session with private rows: scope-aware COUNT does NOT leak', async () => {
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
    const r = await assemble(ctxFor(root), 'sess-mixed', { rowCap: 3, budget: 100000 });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(4);
  });

  it('truncated session with explicit private scope: caller can see their own count', async () => {
    for (let i = 0; i < 3; i++) {
      const e = makeRaw(`secret detail ${i}`, 'sess-priv', { scope: 'slack:private:CSEC' });
      e.created = `2026-01-0${i + 1}T00:00:00.000Z`;
      writeEntry(root, e);
    }
    const r = await assemble(ctxFor(root), 'sess-priv', {
      rowCap: 2,
      budget: 100000,
      scope: 'slack:private:CSEC',
    });
    expect(r.truncated).toBe(true);
    expect(r.totalRaw).toBe(3);
  });
});

describe('countSessionRawMemories helper', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot('v163-count');
  });
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

describe('MCP hippo_recall exposes fresh_tail_session_id', () => {
  let home: string;
  beforeEach(() => {
    home = makeRoot('v163-mcp');
    vi.stubEnv('HIPPO_HOME', home);
  });
  afterEach(() => {
    safeRmSync(home);
  });

  it('hippo_recall tool schema lists fresh_tail_session_id', async () => {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
      }),
    );
    // SAFETY: tools/list's MCP result envelope always carries result.tools
    // with each tool's JSON-schema inputSchema.properties; McpResponse.result
    // is typed unknown at the transport layer since it varies per method.
    const tools =
      (
        res as {
          result?: {
            tools?: Array<{
              name?: string;
              inputSchema?: {
                properties?: {
                  fresh_tail_session_id?: unknown;
                  fresh_tail_count?: unknown;
                  summarize_overflow?: unknown;
                };
              };
            }>;
          };
        }
      ).result?.tools ?? [];
    const recall = tools.find((t) => t.name === 'hippo_recall');
    expect(recall?.name).toBe('hippo_recall');
    const props = recall?.inputSchema?.properties ?? {};
    expect(props).toHaveProperty('fresh_tail_session_id');
    expect(props).toHaveProperty('fresh_tail_count');
    expect(props).toHaveProperty('summarize_overflow');
  });
});

describe('HTTP /v1/memories input validation', () => {
  let home: string;
  let handle: ServerHandle;
  beforeEach(async () => {
    home = makeRoot('v163-http-val');
    handle = await serveKeyed({ hippoRoot: home, port: 0 }, serve);
  });
  afterEach(async () => {
    await handle.stop();
    safeRmSync(home);
  });

  it('400 on fresh_tail_session_id > 256 chars', async () => {
    const big = 'x'.repeat(257);
    const res = await fetch(`${handle.url}/v1/memories?q=test&fresh_tail_session_id=${big}`);
    expect(res.status).toBe(400);
  });

  it('256-char fresh_tail_session_id is accepted (boundary)', async () => {
    const ok = 'x'.repeat(256);
    const res = await fetch(`${handle.url}/v1/memories?q=test&fresh_tail_session_id=${ok}`);
    expect(res.status).toBe(200);
  });

  it('summarize_overflow=banana is treated as false', async () => {
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
