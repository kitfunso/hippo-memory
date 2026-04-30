import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { queryAuditEvents } from '../src/audit.js';
import { remember as apiRemember } from '../src/api.js';
import { handleMcpRequest } from '../src/mcp/server.js';

// v0.39 commit 2 regressions:
//  - lastRecalledIds keyed per-client so two HTTP-MCP clients on the same
//    tenant cannot poison each other's outcome feedback (Fix 2.1)
//  - clientKey built from hash(bearer + remoteAddr) by src/server.ts (Fix 2.2)
//  - hippo_recall / hippo_remember route through src/api.ts so audit_log
//    captures actor='mcp' uniformly with CLI/REST (Fix 2.3)
//  - hippo_share passes ctx.tenantId so a Bearer for tenant A cannot share
//    tenant B's memory to the global store (Fix 2.4)
//  - hippo_outcome reads with ctx.tenantId (Fix 2.5)

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function callTool(
  reqId: number,
  name: string,
  args: Record<string, unknown>,
  ctx: { hippoRoot: string; tenantId: string; actor: string; clientKey?: string },
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: reqId,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx,
  );
}

function extractText(res: unknown): string {
  const r = res as { result?: { content?: Array<{ text?: string }> } } | null;
  return r?.result?.content?.[0]?.text ?? '';
}

describe('v039 mcp tenant + client-key isolation', () => {
  let home: string;
  let globalHome: string;
  let originalHippoHome: string | undefined;

  beforeEach(() => {
    home = makeRoot('v039-mcp');
    globalHome = makeRoot('v039-mcp-global');
    originalHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = globalHome;
  });

  afterEach(() => {
    if (originalHippoHome === undefined) {
      delete process.env.HIPPO_HOME;
    } else {
      process.env.HIPPO_HOME = originalHippoHome;
    }
    try { rmSync(home, { recursive: true, force: true }); } catch { /* windows file locks */ }
    try { rmSync(globalHome, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  // ---- Test 1: lastRecalledIds keyed by clientKey --------------------------
  it('lastRecalledIds is keyed by clientKey — outcome from client B cannot touch client A', async () => {
    // Seed a memory in tenant alpha for both clients to recall.
    const seeded = apiRemember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'shared-canary lastRecalled keyed-by-clientKey alpha-tenant' },
    );

    const ctxA = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:tokenA:1.2.3.4' };
    const ctxB = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:tokenB:5.6.7.8' };

    // Both clients recall the same memory.
    await callTool(1, 'hippo_recall', { query: 'lastRecalled', budget: 1500 }, ctxA);
    await callTool(2, 'hippo_recall', { query: 'lastRecalled', budget: 1500 }, ctxB);

    // Snapshot retrieval_count for the seeded memory before any outcome.
    const before = (() => {
      const db = openHippoDb(home);
      try {
        return db
          .prepare(`SELECT retrieval_count, strength FROM memories WHERE id = ?`)
          .get(seeded.id) as { retrieval_count: number; strength: number };
      } finally {
        closeHippoDb(db);
      }
    })();
    expect(before).toBeDefined();

    // Client B applies a positive outcome. With per-client keying, this
    // touches B's lastRecalledIds set only — both happen to point at the
    // same memory id since they both queried alpha, so this DOES update
    // the memory. The discriminating test: client B has no recalls and
    // client A has recalls → B's outcome must not touch A's set.
    //
    // Probe that branch directly: clear B's set by giving a different
    // clientKey that has never recalled.
    const ctxC = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:tokenC:never-recalled' };
    const cOutcome = await callTool(3, 'hippo_outcome', { good: true }, ctxC);
    expect(extractText(cOutcome)).toMatch(/No recent recalls/i);

    // And client A's set is still active (its recall happened, no outcome
    // applied yet on its key).
    const aOutcome = await callTool(4, 'hippo_outcome', { good: true }, ctxA);
    expect(extractText(aOutcome)).toMatch(/Applied positive outcome to 1 memories/);
  });

  // ---- Test 2: MCP recall produces audit_log with actor='mcp' ---------------
  it('hippo_recall via MCP routes through api.ts and writes audit_log with actor=mcp', async () => {
    apiRemember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'audit-canary recall actor-mcp shape lock' },
    );

    const ctx = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:t:addr' };
    await callTool(1, 'hippo_recall', { query: 'audit-canary', budget: 1500 }, ctx);

    const db = openHippoDb(home);
    try {
      const recallEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'recall' });
      const mcpRecall = recallEvents.find((e) => e.actor === 'mcp');
      expect(mcpRecall).toBeDefined();
      // GDPR Path A: recall audit stores query_hash (sha256/16) instead of
      // truncated query text. Assert hash shape + length, not the original text.
      const meta = mcpRecall!.metadata as {
        query?: string;
        query_hash?: string;
        query_length?: number;
      };
      expect(meta.query).toBeUndefined();
      expect(meta.query_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(typeof meta.query_length).toBe('number');
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 3: MCP remember produces audit_log with actor='mcp' -------------
  it('hippo_remember via MCP routes through api.ts and writes audit_log with actor=mcp', async () => {
    const ctx = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:t:addr' };
    const res = await callTool(
      1,
      'hippo_remember',
      { text: 'audit-canary remember actor-mcp shape lock' },
      ctx,
    );
    expect(extractText(res)).toMatch(/Remembered \[mem_/);

    const db = openHippoDb(home);
    try {
      const rememberEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'remember' });
      const mcpRemember = rememberEvents.find((e) => e.actor === 'mcp');
      expect(mcpRemember).toBeDefined();
      expect(mcpRemember!.targetId).toMatch(/^mem_/);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 3.5: hippo_outcome routes through api.ts (audit_log actor=mcp) -
  it('hippo_outcome via MCP routes through api.ts and writes audit_log with op=outcome actor=mcp', async () => {
    const ctx = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:t:addr-outcome' };
    // Seed a memory + recall it so lastRecalledIds is populated for clientKey.
    apiRemember({ hippoRoot: home, tenantId: 'alpha', actor: 'cli' }, { content: 'outcome-canary memory for audit shape lock' });
    await callTool(1, 'hippo_recall', { query: 'outcome-canary' }, ctx);
    // Apply positive outcome.
    const res = await callTool(2, 'hippo_outcome', { good: true }, ctx);
    expect(extractText(res)).toMatch(/Applied positive outcome to \d+ memories/);

    const db = openHippoDb(home);
    try {
      const outcomeEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'outcome' });
      const mcpOutcome = outcomeEvents.find((e) => e.actor === 'mcp');
      expect(mcpOutcome).toBeDefined();
      expect(mcpOutcome!.targetId).toMatch(/^mem_/);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 4: stdio backward-compat — no clientKey → stdio-${pid} ---------
  it('McpContext with no clientKey falls back to stdio-${pid} and recall/outcome work end-to-end', async () => {
    apiRemember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'stdio-fallback canary backward-compat clientKey-undefined' },
    );

    const ctxNoKey = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp' };

    // Recall sets the keyed Map under the stdio-${pid}:alpha fallback.
    const recallRes = await callTool(1, 'hippo_recall', { query: 'stdio-fallback', budget: 1500 }, ctxNoKey);
    expect(extractText(recallRes)).toContain('stdio-fallback');

    // Outcome under the same no-clientKey context resolves the same fallback
    // key and finds the recalled set.
    const outcomeRes = await callTool(2, 'hippo_outcome', { good: true }, ctxNoKey);
    expect(extractText(outcomeRes)).toMatch(/Applied positive outcome to 1 memories/);
  });

  // ---- Test 5: Cross-tenant outcome blocked under HTTP-MCP -----------------
  // Two HTTP-MCP simulated clients, same tenant but different bearers (so
  // their hash(bearer) prefixes differ → different clientKeys). Client B's
  // outcome on a key client B never recalled returns "No recent recalls".
  it('two HTTP-MCP clients on the same tenant have isolated lastRecalledIds (buildMcpClientKey shape)', async () => {
    apiRemember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'cross-client http-mcp simulated bearer-isolation' },
    );

    // Simulate exactly what server.ts:buildMcpClientKey produces:
    //   `http:${sha256(bearer).slice(0,16)}:${remoteAddr}`
    const bearerA = 'hk_test_alpha_A';
    const bearerB = 'hk_test_alpha_B';
    const remoteAddr = '127.0.0.1';
    const keyA = `http:${createHash('sha256').update(bearerA).digest('hex').slice(0, 16)}:${remoteAddr}`;
    const keyB = `http:${createHash('sha256').update(bearerB).digest('hex').slice(0, 16)}:${remoteAddr}`;
    expect(keyA).not.toBe(keyB);

    const ctxA = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: keyA };
    const ctxB = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: keyB };

    // Only A recalls.
    await callTool(1, 'hippo_recall', { query: 'cross-client', budget: 1500 }, ctxA);

    // B has never recalled — outcome on B's key returns "No recent recalls".
    const bOutcome = await callTool(2, 'hippo_outcome', { good: true }, ctxB);
    expect(extractText(bOutcome)).toMatch(/No recent recalls/i);

    // A's recalled set is intact.
    const aOutcome = await callTool(3, 'hippo_outcome', { good: true }, ctxA);
    expect(extractText(aOutcome)).toMatch(/Applied positive outcome to 1 memories/);
  });

  // ---- Test 6: hippo_share cross-tenant denied -----------------------------
  it('hippo_share cross-tenant: tenant B cannot share tenant A\'s memory to the global store', async () => {
    // Tenant A pushes a memory.
    const a = apiRemember(
      { hippoRoot: home, tenantId: 'alpha', actor: 'cli' },
      { content: 'alpha-private hippo_share cross-tenant exfil canary' },
    );

    // Tenant B's MCP context tries to call hippo_share with A's id. The
    // tool surface returns the JSON-RPC error envelope rather than throwing
    // through to the test — handleMcpRequest catches the executeTool throw
    // only in the HTTP handler, but here we're calling handleMcpRequest
    // directly, so the throw propagates. Wrap accordingly.
    const ctxB = { hippoRoot: home, tenantId: 'bravo', actor: 'mcp', clientKey: 'http:bravo-token:1.2.3.4' };

    let threwNotFound = false;
    try {
      await callTool(1, 'hippo_share', { id: a.id, force: true }, ctxB);
    } catch (err) {
      threwNotFound = /memory not found/i.test(err instanceof Error ? err.message : String(err));
    }
    expect(threwNotFound).toBe(true);

    // The global store must NOT have received a copy of alpha's memory.
    const gdb = openHippoDb(globalHome);
    try {
      const rows = gdb
        .prepare(`SELECT COUNT(*) AS c FROM memories WHERE content LIKE '%alpha-private%'`)
        .get() as { c: number };
      expect(Number(rows.c)).toBe(0);
    } finally {
      closeHippoDb(gdb);
    }

    // Sanity: tenant A can still share its own memory.
    const ctxA = { hippoRoot: home, tenantId: 'alpha', actor: 'mcp', clientKey: 'http:alpha-token:1.2.3.4' };
    const okRes = await callTool(2, 'hippo_share', { id: a.id, force: true }, ctxA);
    expect(extractText(okRes)).toMatch(/Shared \[mem_|Shared \[g_/);
  });
});

