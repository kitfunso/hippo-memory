// A failed token-ledger write never fails the recall that produced the text, but it is logged instead of swallowed.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { adminActor, recordTokens } from '../src/api.js';
import { handleMcpRequest } from '../src/mcp/server.js';
import { resetLogOnce } from '../src/log.js';
import { createMemory } from './_helpers/default-half-life-memory.js';

let root: string;
let stderrSpy: MockInstance<typeof process.stderr.write>;

function ledgerLines(): string[] {
  return stderrSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('token ledger write failed'));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ledger-fail-'));
  initStore(root);
  const db = openHippoDb(root);
  db.exec('DROP TABLE token_ledger');
  closeHippoDb(db);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  resetLogOnce();
});

afterEach(() => {
  stderrSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('token ledger write failures', () => {
  it('api.recordTokens warns once and does not throw', () => {
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    expect(() => recordTokens(ctx, 'http_recall', { items: 1, tokens: 10 })).not.toThrow();
    recordTokens(ctx, 'http_recall', { items: 1, tokens: 10 });
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[hippo\] warn: .*no such table: token_ledger/);
  });

  it('an MCP recall still answers and the ledger failure is warned', async () => {
    writeEntry(root, createMemory('ledger probe note about deploys'));
    const res = await handleMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hippo_recall', arguments: { query: 'deploys' } } },
      { hippoRoot: root, tenantId: 'default', actor: 'mcp' },
    );
    expect(res?.error).toBeUndefined();
    expect(JSON.stringify(res?.result)).toContain('ledger probe note');
    expect(ledgerLines()).toHaveLength(1);
  });
});
