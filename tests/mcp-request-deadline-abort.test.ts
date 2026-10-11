// A tool call whose request signal has aborted stops before it reads or writes the store.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { handleMcpRequest, type McpContext } from '../src/mcp/server.js';
import { runWithRequestId } from '../src/util/request-scope.js';

let root: string;
let ctx: McpContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-mcp-abort-'));
  initStore(root);
  ctx = { hippoRoot: root, tenantId: 'default', actor: 'test', role: 'admin' };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const REMEMBER = { jsonrpc: '2.0' as const, id: 1, method: 'tools/call', params: { name: 'hippo_remember', arguments: { text: 'a fact that must not be stored' } } };

describe('a tool call at its request deadline', () => {
  it('rejects with the deadline error and stores nothing once the signal has aborted', async () => {
    const abort = new AbortController();
    abort.abort(new DOMException('hippo_remember did not finish within 5 ms', 'TimeoutError'));
    await expect(runWithRequestId('req-abort', () => handleMcpRequest(REMEMBER, ctx), undefined, abort.signal)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(loadAllEntries(root)).toHaveLength(0);
  });

  it('runs the same call to completion while the signal stays quiet', async () => {
    const abort = new AbortController();
    const reply = await runWithRequestId('req-ok', () => handleMcpRequest(REMEMBER, ctx), undefined, abort.signal);
    expect(reply?.error).toBeUndefined();
    expect(loadAllEntries(root)).toHaveLength(1);
  });
});
