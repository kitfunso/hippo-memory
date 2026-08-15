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
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, Layer, MemoryKind } from '../src/memory.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { RecallContractError } from '../src/api.js';

function makeRoot(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), `hippo-${prefix}-`));
  mkdirSync(join(home, '.hippo'), { recursive: true });
  initStore(home);
  return home;
}

function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { hippoRoot: string; tenantId: string; actor: string },
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

describe('mcp hippo_recall fresh-tail policy F5 (v1.6.5)', () => {
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
        kind: 'raw' as MemoryKind,
      }));
    }
    let thrown: unknown = null;
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
    expect((thrown as RecallContractError).code).toBe(
      'fresh_tail_requires_session_id',
    );
    expect((thrown as RecallContractError).message).toContain(
      'HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL',
    );
  });

  it('env=1, session_id provided → no error, content returned', async () => {
    process.env.HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL = '1';
    for (let i = 0; i < 3; i++) {
      writeEntry(home, createMemory(`event ${i}`, {
        layer: Layer.Buffer,
        kind: 'raw' as MemoryKind,
        source_session_id: 'sess-A',
      }));
    }
    const res = await callTool(
      'hippo_recall',
      { query: 'event', fresh_tail_count: 3, fresh_tail_session_id: 'sess-A' },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
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
        kind: 'raw' as MemoryKind,
      }));
    }
    const res = await callTool(
      'hippo_recall',
      { query: 'event', fresh_tail_count: 3 },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    const r = res as {
      error?: { code: number; message: string };
      result?: unknown;
    };
    expect(r.error).toBeUndefined();
  });
});
