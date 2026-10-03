// tools/call arguments are checked against the tool's inputSchema before the tool runs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadAllEntries } from '../src/store.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';
import { validateToolArgs, type ToolInputSchema } from '../src/mcp/tool-args.js';

type Wire = string | number | boolean | null | Wire[] | { [key: string]: Wire };

interface ToolReply {
  error?: { code: number; message: string };
  isError: boolean;
  text: string;
}

function reply(res: McpResponse | null): ToolReply {
  // SAFETY: a tools/call reply is either a JSON-RPC error or a result with text content blocks.
  const r = res as { error?: { code: number; message: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } } | null;
  return { error: r?.error, isError: r?.result?.isError === true, text: r?.result?.content?.[0]?.text ?? '' };
}

describe('MCP tool argument validation', () => {
  let home: string;
  let prevHippoHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hippo-mcp-args-'));
    mkdirSync(join(home, '.hippo'), { recursive: true });
    initStore(home);
    prevHippoHome = process.env.HIPPO_HOME;
    process.env.HIPPO_HOME = join(home, '.hippo-global');
  });

  afterEach(() => {
    if (prevHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = prevHippoHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function call(name: string, args: Wire): Promise<ToolReply> {
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      { hippoRoot: home, tenantId: 'default', actor: 'mcp' },
    );
    return reply(res);
  }

  it('rejects an unknown tool with a JSON-RPC invalid-params error', async () => {
    const r = await call('hippo_nope', {});
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toContain('Unknown tool: hippo_nope');
  });

  it('rejects non-object arguments with a JSON-RPC invalid-params error', async () => {
    const r = await call('hippo_status', 'not-an-object');
    expect(r.error?.code).toBe(-32602);
  });

  it('rejects an out-of-range budget', async () => {
    const r = await call('hippo_recall', { query: 'x', budget: 1_000_000_000 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('budget must be <= 100000');
  });

  it('rejects a negative budget', async () => {
    const r = await call('hippo_assemble', { session_id: 's1', budget: -5 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('budget must be >= 0');
  });

  it('rejects a drill limit above the HTTP list cap', async () => {
    const r = await call('hippo_drill', { summary_id: 'missing', limit: 5000 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('limit must be <= 1000');
  });

  it('rejects a wrong type', async () => {
    const r = await call('hippo_recall', { query: 'x', budget: 'lots' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('budget must be a number');
  });

  it('rejects a fractional integer field', async () => {
    const r = await call('hippo_drill', { summary_id: 'missing', depth: 1.5 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('depth must be an integer');
  });

  it('rejects a missing required field', async () => {
    const r = await call('hippo_recall', { budget: 100 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('query is required');
  });

  it('rejects before the tool runs, so a bad remember writes nothing', async () => {
    const r = await call('hippo_remember', { text: 'kept out', pin: 'yes' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('pin must be a boolean');
    expect(loadAllEntries(home, 'default')).toHaveLength(0);
  });

  it('lets a valid call through unchanged', async () => {
    const remembered = await call('hippo_remember', { text: 'validation keeps valid calls working' });
    expect(remembered.isError).toBe(false);
    expect(remembered.text).toMatch(/^Remembered \[/);
    const recalled = await call('hippo_recall', { query: 'validation', budget: 4000 });
    expect(recalled.error).toBeUndefined();
    expect(recalled.isError).toBe(false);
    expect(recalled.text).toContain('validation keeps valid calls working');
  });
});

describe('validateToolArgs', () => {
  const schema: ToolInputSchema = {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['bm25', 'hybrid'] },
      id: { type: 'string', maxLength: 4 },
    },
    required: ['mode'],
  };

  it('accepts an enum member and passes undeclared properties through', () => {
    expect(validateToolArgs(schema, { mode: 'bm25', extra: 1 })).toEqual([]);
  });

  it('rejects a value outside the enum', () => {
    expect(validateToolArgs(schema, { mode: 'physics' })).toEqual(['mode must be one of "bm25", "hybrid" (got "physics")']);
  });

  it('rejects a string over maxLength and reports every problem', () => {
    expect(validateToolArgs(schema, { id: 'abcdef' })).toEqual([
      'mode is required',
      'id must be at most 4 characters (got 6)',
    ]);
  });

  it('rejects null for a typed field', () => {
    expect(validateToolArgs(schema, { mode: null })).toEqual(['mode must be a string (got null)']);
  });
});
