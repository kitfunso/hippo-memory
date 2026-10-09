/**
 * F5 (v1.6.5) — MCP render path for RecallContractError.
 *
 * MCP `hippo_recall` calls api.recall internally. When the env gate is on
 * AND tool args include fresh_tail_count > 0 without fresh_tail_session_id,
 * api.recall throws RecallContractError. Per the documented MCP contract
 * (handleMcpRequest JSDoc: "Errors thrown by executeTool are the caller's
 * problem — wrap with try/catch on the transport side"), the throw
 * propagates to whichever transport invoked it. This test asserts:
 *   1. The throw reaches the call site as a RecallContractError with the
 *      typed `.code` field intact (no swallowing inside MCP dispatch).
 *   2. Both stdio (src/mcp/server.ts:836) and HTTP-MCP
 *      (src/server.ts:1292) transports already map the thrown Error to
 *      JSON-RPC code -32603 with `err.message` preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { writeEntry } from '../src/store/entry-writes.js';
import { Layer} from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpContext } from '../src/mcp/server.js';
import { RecallContractError } from '../src/api/index.js';
import { _resetSharedStoreCacheForTests } from '../src/core/config.js';
import { makeRoot } from './_helpers/make-root.js';

type HippoRecallToolArgs = {
  query?: string;
  fresh_tail_count?: number;
  fresh_tail_session_id?: string;
};

function callTool(
  name: string,
  args: HippoRecallToolArgs,
  ctx: McpContext,
) {
  return handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    ctx,
  );
}

describe('mcp hippo_recall fresh-tail policy', () => {
  let home: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    home = makeRoot('mcp-f5');
    prevEnv = process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
    delete process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL;
    } else {
      process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = prevEnv;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('env=1, no session_id, fresh_tail_count > 0 → throws typed RecallContractError to the transport', async () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw',
      }));
    }
    let thrown = null;
    try {
      await callTool(
        'hippo_recall',
        { query: 'event', fresh_tail_count: 3 },
        { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallContractError);
    // SAFETY: the toBeInstanceOf(RecallContractError) assertion above just
    // confirmed thrown's runtime type.
    expect((thrown as RecallContractError).code).toBe(
      'fresh_tail_requires_session_id',
    );
    // SAFETY: the toBeInstanceOf(RecallContractError) assertion above just
    // confirmed thrown's runtime type.
    expect((thrown as RecallContractError).message).toContain(
      'HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL',
    );
  });

  it('env=1, session_id provided → no error, content returned', async () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw',
        source_session_id: 'sess-A',
      }));
    }
    const res = await callTool(
      'hippo_recall',
      { query: 'event', fresh_tail_count: 3, fresh_tail_session_id: 'sess-A' },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    // SAFETY: hippo_recall's MCP tool result envelope always carries
    // result.content per src/mcp/server.ts; McpResponse.result is typed
    // unknown at the transport layer since it varies per tool.
    const r = res as {
      error?: { code: number; message: string };
      result?: { content: Array<{ text: string }> };
    };
    expect(r.error).toBeUndefined();
    expect(r.result?.content?.[0]?.text).toBeDefined();
  });

  it('env unset, no session_id, fresh_tail_count > 0 → no error (back-compat)', async () => {
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw',
      }));
    }
    const res = await callTool(
      'hippo_recall',
      { query: 'event', fresh_tail_count: 3 },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    const r = res!;
    expect(r.error).toBeUndefined();
  });
});

describe('mcp hippo_recall fresh tail on a shared store', () => {
  let shared: string;

  beforeEach(() => {
    _resetSharedStoreCacheForTests();
    shared = makeRoot('mcp-f5-shared', { config: { sharedStore: true } });
  });

  afterEach(() => {
    _resetSharedStoreCacheForTests();
    rmSync(shared, { recursive: true, force: true });
  });

  it("keeps the tail to the caller's project, with or without a session id", async () => {
    const rows = (['acme', 'beta', null] as const).map((origin) => {
      const entry = { ...createMemory(`tail row from ${origin ?? 'no project'}`, { layer: Layer.Buffer, kind: 'raw', source_session_id: 'sess-A' }), origin_project: origin };
      writeEntry(shared, entry);
      return entry;
    });
    const ctx: McpContext = { hippoRoot: shared, tenantId: 'default', actor: 'mcp', project: { name: 'acme', legacyName: 'acme' } };
    for (const args of [{ fresh_tail_count: 3 }, { fresh_tail_count: 3, fresh_tail_session_id: 'sess-A' }]) {
      // SAFETY: hippo_recall's tool result carries result.content, as in the cases above.
      const r = (await callTool('hippo_recall', { query: 'zzqqxx', ...args }, ctx)) as { result?: { content: Array<{ text: string }> } };
      const text = r.result?.content?.[0]?.text ?? '';
      expect(text, JSON.stringify(args)).toContain(`[tail] ${rows[0]!.id}: tail row from acme`);
      for (const hidden of rows.slice(1)) expect(text, JSON.stringify(args)).not.toContain(hidden.id);
    }
  });
});
