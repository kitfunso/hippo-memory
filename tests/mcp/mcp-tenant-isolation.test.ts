import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { queryAuditEvents } from '../../src/store/sqlite/audit.js';
import { remember as apiRemember } from '../../src/api/index.js';
import { handleMcpRequest, type McpResponse, type McpContext } from '../../src/surface/mcp/server.js';
import { createCallerState, type CallerState } from '../../src/api/callers.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { HippoStore } from '../../src/store/index.js';
import { apiCtx, testReach } from '../_helpers/api-ctx.js';
import { loadConfig } from '../../src/host/config-file.js';
import { oneRequestPerTest, removeAfterRequest } from '../_helpers/one-request-per-test.js';
import { testInfra } from '../_helpers/infra.js';

oneRequestPerTest();

// Every MCP tool takes tenant and client from its own context, so one caller can never read, share or score another's memories.

function callTool(reqId: number, name: string, args: Record<string, string | number | boolean>, ctx: McpContext) {
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

function extractText(res: McpResponse | null): string {
  // SAFETY: every hippo_* tool handler under test returns the standard MCP
  // tool-call result shape { content: [{ type: 'text', text: string }] }.
  const r = res?.result as { content?: Array<{ text?: string }> } | undefined;
  return r?.content?.[0]?.text ?? '';
}

describe('mcp tenant + client-key isolation', () => {
  let home: string;
  let globalHome: string;
  // The callers a transport root holds; each case gets its own, as each server or stdio loop does.
  let callers: CallerState;

  beforeEach(() => {
    callers = createCallerState();
    home = makeRoot('mcp-tenant');
    globalHome = makeRoot('mcp-tenant-global');
    vi.stubEnv('HIPPO_HOME', globalHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    removeAfterRequest(home);
    removeAfterRequest(globalHome);
  });

  // ---- Test 1: last-shown list keyed by clientKey --------------------------
  it('last-shown list is keyed by clientKey: outcome from client B cannot touch client A', async () => {
    // Seed a memory in tenant alpha for both clients to recall.
    const seeded = await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'shared-canary lastRecalled keyed-by-clientKey alpha-tenant',
    });

    const ctxA = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:tokenA:1.2.3.4',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    const ctxB = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:tokenB:5.6.7.8',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };

    // Both clients recall the same memory.
    await callTool(1, 'hippo_recall', { query: 'lastRecalled', budget: 1500 }, ctxA);
    await callTool(2, 'hippo_recall', { query: 'lastRecalled', budget: 1500 }, ctxB);

    // Snapshot retrieval_count for the seeded memory before any outcome.
    const before = (() => {
      const db = openHippoDb(home);
      try {
        // SAFETY: `seeded` was just written via apiRemember above, so its row
        // exists and always has retrieval_count and strength columns.
        return db.prepare(`SELECT retrieval_count, strength FROM memories WHERE id = ?`).get(seeded.id) as {
          retrieval_count: number;
          strength: number;
        };
      } finally {
        closeHippoDb(db);
      }
    })();
    expect(before.retrieval_count).toBe(2);

    // Client B applies a positive outcome. With per-client keying, this
    // touches B's last-shown list set only; both happen to point at the
    // same memory id since they both queried alpha, so this DOES update
    // the memory. The discriminating test: client B has no recalls and
    // client A has recalls → B's outcome must not touch A's set.
    //
    // Probe that branch directly: clear B's set by giving a different
    // clientKey that has never recalled.
    const ctxC = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:tokenC:never-recalled',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    const cOutcome = await callTool(3, 'hippo_outcome', { good: true }, ctxC);
    expect(extractText(cOutcome)).toMatch(/No recent recalls/i);

    // And client A's set is still active (its recall happened, no outcome
    // applied yet on its key).
    const aOutcome = await callTool(4, 'hippo_outcome', { good: true }, ctxA);
    expect(extractText(aOutcome)).toMatch(/Applied positive outcome to 1 memories/);
  });

  // ---- Test 2: MCP recall produces audit_log with actor='mcp' ---------------
  it('hippo_recall via MCP routes through api.ts and writes audit_log with actor=mcp', async () => {
    await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'audit-canary recall actor-mcp shape lock',
    });

    const ctx = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:t:addr',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    await callTool(1, 'hippo_recall', { query: 'audit-canary', budget: 1500 }, ctx);

    const db = openHippoDb(home);
    try {
      const recallEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'recall' });
      const mcpRecall = recallEvents.find((e) => e.actor === 'mcp');
      // GDPR Path A: recall audit stores query_hash (sha256/16) instead of
      // truncated query text. Assert hash shape + length, not the original text.
      // SAFETY: the 'recall' op's audit metadata is always written by
      // src/api/index.ts (see query_length comment there) with exactly these fields.
      const meta = mcpRecall!.metadata as {
        query?: string;
        query_hash?: string;
        query_length?: number;
      };
      expect(meta.query).toBeUndefined();
      expect(meta.query_hash).toMatch(/^[0-9a-f]{16}$/);
      expect(Number.isInteger(meta.query_length)).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 3: MCP remember produces audit_log with actor='mcp' -------------
  it('hippo_remember via MCP routes through api.ts and writes audit_log with actor=mcp', async () => {
    const ctx = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:t:addr',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    const res = await callTool(1, 'hippo_remember', { text: 'audit-canary remember actor-mcp shape lock' }, ctx);
    expect(extractText(res)).toMatch(/Remembered \[mem_/);

    const db = openHippoDb(home);
    try {
      const rememberEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'remember' });
      const mcpRemember = rememberEvents.find((e) => e.actor === 'mcp');
      expect(mcpRemember!.targetId).toMatch(/^mem_/);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 3.5: hippo_outcome routes through api.ts (audit_log actor=mcp) -
  it('hippo_outcome via MCP routes through api.ts and writes audit_log with op=outcome actor=mcp', async () => {
    const ctx = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:t:addr-outcome',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    // Seed a memory + recall it so last-shown list is populated for clientKey.
    await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'outcome-canary memory for audit shape lock',
    });
    await callTool(1, 'hippo_recall', { query: 'outcome-canary' }, ctx);
    // Apply positive outcome.
    const res = await callTool(2, 'hippo_outcome', { good: true }, ctx);
    expect(extractText(res)).toMatch(/Applied positive outcome to \d+ memories/);

    const db = openHippoDb(home);
    try {
      const outcomeEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'outcome' });
      const mcpOutcome = outcomeEvents.find((e) => e.actor === 'mcp');
      expect(mcpOutcome!.targetId).toMatch(/^mem_/);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 4: stdio backward-compat — no clientKey → stdio-${pid} ---------
  it('McpContext with no clientKey falls back to stdio-${pid} and recall/outcome work end-to-end', async () => {
    await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'stdio-fallback canary backward-compat clientKey-undefined',
    });

    const ctxNoKey = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };

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
  it('two HTTP-MCP clients on the same tenant have isolated last-shown list (clientKeyOf shape)', async () => {
    await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'cross-client http-mcp simulated bearer-isolation',
    });

    // Simulate exactly what surface/server/client-key.ts clientKeyOf produces:
    //   `http:${sha256(bearer).slice(0,16)}:${remoteAddr}`
    const bearerA = 'hk_test_alpha_A';
    const bearerB = 'hk_test_alpha_B';
    const remoteAddr = '127.0.0.1';
    const keyA = `http:${createHash('sha256').update(bearerA).digest('hex').slice(0, 16)}:${remoteAddr}`;
    const keyB = `http:${createHash('sha256').update(bearerB).digest('hex').slice(0, 16)}:${remoteAddr}`;
    expect(keyA).not.toBe(keyB);

    const ctxA = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: keyA,
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    const ctxB = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: keyB,
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };

    // Only A recalls.
    await callTool(1, 'hippo_recall', { query: 'cross-client', budget: 1500 }, ctxA);

    // B has never recalled — outcome on B's key returns "No recent recalls".
    const bOutcome = await callTool(2, 'hippo_outcome', { good: true }, ctxB);
    expect(extractText(bOutcome)).toMatch(/No recent recalls/i);

    // A's recalled set is intact.
    const aOutcome = await callTool(3, 'hippo_outcome', { good: true }, ctxA);
    expect(extractText(aOutcome)).toMatch(/Applied positive outcome to 1 memories/);
  });

  // One key held by a session in each repo: the project is part of the outcome key, so beta cannot rate acme's recall.
  it('one clientKey with two projects keeps a last-shown list entry per project', async () => {
    await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'per-project outcome key canary',
      project: { name: 'acme' },
    });
    const base = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:shared-key:1.2.3.4',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    const acme: McpContext = { ...base, project: { name: 'acme', legacyName: 'acme' } };
    const beta: McpContext = { ...base, project: { name: 'beta', legacyName: 'beta' } };

    await callTool(1, 'hippo_recall', { query: 'per-project outcome', budget: 1500 }, acme);
    expect(extractText(await callTool(2, 'hippo_outcome', { good: true }, beta))).toMatch(/No recent recalls/i);
    expect(extractText(await callTool(3, 'hippo_outcome', { good: true }, acme))).toMatch(
      /Applied positive outcome to 1 memories/,
    );
  });

  it('caps last-shown list at MAX_RECALL_CLIENTS, dropping the client that recalled longest ago', async () => {
    await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'recall client cap canary',
      project: { name: 'acme' },
    });
    const MAX_RECALL_CLIENTS = 4096;
    {
      for (let i = 0; i < MAX_RECALL_CLIENTS; i++) callers.lastShown.set(`flood:${i}`, []);
      callers.lastShown.set('flood:0', []);
      const acme: McpContext = {
        hippoRoot: home,
        tenantId: 'alpha',
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        clientKey: 'http:cap-key:1.2.3.4',
        project: { name: 'acme', legacyName: 'acme' },
        store: sqliteStore(home),
        config: loadConfig(home),
        infra: testInfra(),
        callers,
      };
      await callTool(1, 'hippo_recall', { query: 'client cap canary', budget: 1500 }, acme);
      expect(callers.lastShown.size).toBe(MAX_RECALL_CLIENTS);
      expect(callers.lastShown.has('flood:1')).toBe(false);
      expect(callers.lastShown.has('flood:0')).toBe(true);
      expect(extractText(await callTool(2, 'hippo_outcome', { good: true }, acme))).toMatch(
        /Applied positive outcome to 1 memories/,
      );
    }
  });

  // ---- Test 6: hippo_share cross-tenant denied -----------------------------
  it("hippo_share cross-tenant: tenant B cannot share tenant A's memory to the global store", async () => {
    // Tenant A pushes a memory.
    const a = await apiRemember(apiCtx(home, 'alpha', { subject: 'cli', role: 'admin' }), {
      content: 'alpha-private hippo_share cross-tenant exfil canary',
    });

    // Tenant B's MCP context tries to call hippo_share with A's id. The
    // tool surface returns the JSON-RPC error envelope rather than throwing
    // through to the test — handleMcpRequest catches the executeTool throw
    // only in the HTTP handler, but here we're calling handleMcpRequest
    // directly, so the throw propagates. Wrap accordingly.
    const store = sqliteStore(home);
    const reach = testReach(home, store);
    const ctxB = {
      hippoRoot: home,
      tenantId: 'bravo',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:bravo-token:1.2.3.4',
      store,
      reach,
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };

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
      // SAFETY: `SELECT COUNT(*) AS c` always returns exactly one row shaped { c: number }.
      const rows = gdb.prepare(`SELECT COUNT(*) AS c FROM memories WHERE content LIKE '%alpha-private%'`).get() as {
        c: number;
      };
      expect(Number(rows.c)).toBe(0);
    } finally {
      closeHippoDb(gdb);
    }

    // Sanity: tenant A can still share its own memory.
    const ctxA = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'mcp',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:alpha-token:1.2.3.4',
      store,
      reach,
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };
    const okRes = await callTool(2, 'hippo_share', { id: a.id, force: true }, ctxA);
    expect(extractText(okRes)).toMatch(/Shared \[mem_|Shared \[g_/);
  });

  // ---- Test 7: T2 — ctx.actor threads into audit_log subject ---------------
  // Under HTTP-MCP ctx.actor carries the auth-resolved subject, so it must be the audit_log actor for remember and outcome.
  it('hippo_remember and hippo_outcome via MCP thread ctx.actor into audit_log subject', async () => {
    const ctx = {
      hippoRoot: home,
      tenantId: 'alpha',
      actor: 'user:alice',
      role: 'admin' as const,
      hostAdmin: true as const,
      clientKey: 'http:alice:addr',
      store: sqliteStore(home),
      config: loadConfig(home),
      infra: testInfra(),
      callers,
    };

    const rememberRes = await callTool(
      1,
      'hippo_remember',
      { text: 'T2-canary remember actor-threading user-alice' },
      ctx,
    );
    expect(extractText(rememberRes)).toMatch(/Remembered \[mem_/);

    await callTool(2, 'hippo_recall', { query: 'T2-canary' }, ctx);
    const outcomeRes = await callTool(3, 'hippo_outcome', { good: true }, ctx);
    expect(extractText(outcomeRes)).toMatch(/Applied positive outcome to \d+ memories/);

    const db = openHippoDb(home);
    try {
      const rememberEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'remember' });
      const aliceRemember = rememberEvents.find((e) => e.actor === 'user:alice');
      expect(aliceRemember!.targetId).toMatch(/^mem_/);

      const outcomeEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'outcome' });
      const aliceOutcome = outcomeEvents.find((e) => e.actor === 'user:alice');
      expect(aliceOutcome?.targetId).toMatch(/^mem_/);

      // A recall's side effects (retrieval persist, anchoring and availability audits) must carry the
      // resolved actor too, so one authenticated recall never spreads audit rows across principals.
      const allAlphaEvents = queryAuditEvents(db, { tenantId: 'alpha' });
      const principals = new Set(allAlphaEvents.map((e) => e.actor));
      expect(principals.has('cli')).toBe(false);
      expect(principals.has('mcp')).toBe(false);
    } finally {
      closeHippoDb(db);
    }
  });

  // ---- Test 8: T2 — actor not supplied still falls back to 'mcp' -----------
  // The whole ctx is not omitted: with no hippoRoot, findHippoRoot() walks up to the developer's real store and the test would write into it.
  // Leaving only actor unset reaches the same `??` fallback.
  it('MCP context with actor omitted falls back to "mcp" in audit_log (ctx?.actor ?? "mcp" pin)', async () => {
    const store: HippoStore = sqliteStore(home);
    const res = await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_remember', arguments: { text: 'T2-canary fallback no-actor-supplied' } },
      },
      // SAFETY: actor is deliberately omitted to exercise the `ctx?.actor ??
      // 'mcp'` fallback under test; handleMcpRequest only ever reads
      // ctx?.actor optionally, so the missing required field is safe at
      // runtime and is exactly the shape this test needs.
      {
        hippoRoot: home,
        tenantId: 'alpha',
        clientKey: 'http:no-actor:addr',
        store,
        config: loadConfig(home),
        callers,
      } as McpContext,
    );
    expect(extractText(res)).toMatch(/Remembered \[mem_/);

    const db = openHippoDb(home);
    try {
      const rememberEvents = queryAuditEvents(db, { tenantId: 'alpha', op: 'remember' });
      const fallbackRemember = rememberEvents.find((e) => e.actor === 'mcp');
      expect(fallbackRemember!.targetId).toMatch(/^mem_/);
    } finally {
      closeHippoDb(db);
    }
  });
});
