import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Layer } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { handleMcpRequest, type McpContext } from '../../src/surface/mcp/server.js';
import { RecallContractError } from '../../src/api/index.js';
import { cliConfig } from '../../src/surface/cli/api-context.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { writeEntry } from '../_helpers/root-forms.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { testInfra } from '../_helpers/infra.js';
import { mcpContext } from '../_helpers/mcp-context.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

type HippoRecallToolArgs = {
  query?: string;
  fresh_tail_count?: number;
  fresh_tail_session_id?: string;
};

function callTool(name: string, args: HippoRecallToolArgs, ctx: McpContext) {
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

  beforeEach(() => {
    home = makeRoot('mcp-f5');
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', undefined);
  });

  afterEach(() => {
    removeDir(home);
  });

  it('env=1, no session_id, fresh_tail_count > 0 → throws typed RecallContractError to the transport', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`event ${i}`, {
          layer: Layer.Buffer,
          kind: 'raw',
        }),
      );
    }
    let thrown = null;
    try {
      await callTool(
        'hippo_recall',
        { query: 'event', fresh_tail_count: 3 },
        mcpContext({
          hippoRoot: home,
          tenantId: 'default',
          actor: 'mcp',
          role: 'admin',
          hostAdmin: true,
          store: sqliteStore(home),
          config: cliConfig(home),
          infra: testInfra(),
        }),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecallContractError);
    // SAFETY: the toBeInstanceOf(RecallContractError) assertion above just
    // confirmed thrown's runtime type.
    expect((thrown as RecallContractError).code).toBe('fresh_tail_requires_session_id');
    // SAFETY: the toBeInstanceOf(RecallContractError) assertion above just
    // confirmed thrown's runtime type.
    expect((thrown as RecallContractError).message).toContain('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL');
  });

  it('env=1, session_id provided → no error, content returned', async () => {
    vi.stubEnv('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', '1');
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`event ${i}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          sourceSessionId: 'sess-A',
        }),
      );
    }
    const res = await callTool(
      'hippo_recall',
      { query: 'event', fresh_tail_count: 3, fresh_tail_session_id: 'sess-A' },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: cliConfig(home),
        infra: testInfra(),
      }),
    );
    // SAFETY: hippo_recall's MCP tool result envelope always carries
    // result.content per src/surface/mcp/server.ts; McpResponse.result is typed
    // unknown at the transport layer since it varies per tool.
    const r = res as {
      error?: { code: number; message: string };
      result?: { content: Array<{ text: string }> };
    };
    expect(r.error).toBeUndefined();
    const text = r.result?.content?.[0]?.text ?? '';
    expect(text).toContain('Found 3 memories:');
    for (let i = 0; i < 3; i++) expect(text).toContain(`\nevent ${i}\n`);
    expect(text).not.toContain('[tail]');
  });

  it('previews a tail row by its content, so a lead-in cannot fill the cut', async () => {
    const lead = 'user: How often do you and Mel run?';
    const row = createMemory('Three times a week; it keeps us on track.', {
      layer: Layer.Buffer,
      kind: 'raw',
      sourceSessionId: 'sess-A',
      leadIn: lead,
    });
    writeEntry(home, row);
    const res = await callTool(
      'hippo_recall',
      { query: 'zzqqxx', fresh_tail_count: 1, fresh_tail_session_id: 'sess-A' },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: cliConfig(home),
        infra: testInfra(),
      }),
    );
    // SAFETY: hippo_recall's tool result carries result.content, as in the cases above.
    const text = (res as { result?: { content: Array<{ text: string }> } }).result?.content?.[0]?.text ?? '';
    const line = text.split('\n').find((l) => l.startsWith(`- [tail] ${row.id}:`));
    expect(line).toBe(`- [tail] ${row.id}: Three times a week; it keeps us on track.`);
    expect(text).not.toContain(lead);
  });

  it('env unset, no session_id, fresh_tail_count > 0 → no error (back-compat)', async () => {
    for (let i = 0; i < 3; i++) {
      writeEntry(
        home,
        createMemory(`event ${i}`, {
          layer: Layer.Buffer,
          kind: 'raw',
        }),
      );
    }
    const res = await callTool(
      'hippo_recall',
      { query: 'event', fresh_tail_count: 3 },
      mcpContext({
        hippoRoot: home,
        tenantId: 'default',
        actor: 'mcp',
        role: 'admin',
        hostAdmin: true,
        store: sqliteStore(home),
        config: cliConfig(home),
        infra: testInfra(),
      }),
    );
    const r = res!;
    expect(r.error).toBeUndefined();
  });
});

describe('mcp hippo_recall fresh tail on a shared store', () => {
  let shared: string;

  beforeEach(() => {
    shared = makeRoot('mcp-f5-shared', { config: { sharedStore: true } });
  });

  afterEach(() => {
    removeDir(shared);
  });

  it("keeps the tail to the caller's project, with or without a session id", async () => {
    const rows = (['acme', 'beta', null] as const).map((origin) => {
      const entry = {
        ...createMemory(`tail row from ${origin ?? 'no project'}`, {
          layer: Layer.Buffer,
          kind: 'raw',
          sourceSessionId: 'sess-A',
        }),
        originProject: origin,
      };
      writeEntry(shared, entry);
      return entry;
    });
    const ctx: McpContext = mcpContext({
      hippoRoot: shared,
      tenantId: 'default',
      actor: 'mcp',
      role: 'admin',
      hostAdmin: true,
      project: { name: 'acme', legacyName: 'acme' },
      store: sqliteStore(shared),
      config: cliConfig(shared),
      infra: testInfra(),
    });
    for (const args of [{ fresh_tail_count: 3 }, { fresh_tail_count: 3, fresh_tail_session_id: 'sess-A' }]) {
      // SAFETY: hippo_recall's tool result carries result.content, as in the cases above.
      const r = (await callTool('hippo_recall', { query: 'zzqqxx', ...args }, ctx)) as {
        result?: { content: Array<{ text: string }> };
      };
      const text = r.result?.content?.[0]?.text ?? '';
      expect(text, JSON.stringify(args)).toContain(`[tail] ${rows[0]!.id}: tail row from acme`);
      for (const hidden of rows.slice(1)) expect(text, JSON.stringify(args)).not.toContain(hidden.id);
    }
  });
});
