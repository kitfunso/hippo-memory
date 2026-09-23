// MCP auto-sleep: a remember that lands while a sleep runs on the same store must not start a second one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { handleMcpRequest } from '../src/mcp/server.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function remember(hippoRoot: string, text: string) {
  return handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_remember', arguments: { text } } },
    { hippoRoot, tenantId: 'default', actor: 'mcp' },
  );
}

function sleepRuns(hippoRoot: string): number {
  const db = openHippoDb(hippoRoot);
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM consolidation_runs').get<{ n: number }>().n;
  } finally {
    closeHippoDb(db);
  }
}

describe('MCP auto-sleep', () => {
  it('runs one sleep per store at a time, and the next once that one settles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-mcp-autosleep-'));
    roots.push(root);
    initStore(root);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ autoSleep: { enabled: true, threshold: 1 } }));
    // A sleep sends each new episodic memory to fact extraction, so holding that reply keeps the sleep running.
    const sent: string[] = [];
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-not-a-key');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      await held;
      return new Response(JSON.stringify({ content: [{ text: '[]' }] }), { status: 200 });
    }));

    await remember(root, 'the deploy moved to friday');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await remember(root, 'alice owns the billing service');
    release();
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(1));
    expect(sent.filter((body) => body.includes('alice owns the billing service'))).toEqual([]);

    await remember(root, 'alice reviews every schema change');
    await vi.waitFor(() => expect(sleepRuns(root)).toBe(2));
  });
});
