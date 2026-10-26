// A tool call whose request signal has aborted stops before it reads or writes the store.
import { beforeEach, describe, expect, it } from 'vitest';
import { handleMcpRequest, type McpContext } from '../../src/surface/mcp/server.js';
import { runWithRequestId } from '../../src/base/util/request-scope.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadConfig } from '../../src/host/config-file.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { testInfra } from '../_helpers/infra.js';

let root: string;
let ctx: McpContext;

beforeEach(() => {
  root = makeRoot('mcp-abort');
  ctx = {
    hippoRoot: root,
    tenantId: 'default',
    actor: 'test',
    role: 'admin',
    store: sqliteStore(root),
    config: loadConfig(root),
    infra: testInfra(),
  };
});

const REMEMBER = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'tools/call',
  params: { name: 'hippo_remember', arguments: { text: 'a fact that must not be stored' } },
};

describe('a tool call at its request deadline', () => {
  it('rejects with the deadline error and stores nothing once the signal has aborted', async () => {
    const abort = new AbortController();
    abort.abort(new DOMException('hippo_remember did not finish within 5 ms', 'TimeoutError'));
    await expect(
      runWithRequestId('req-abort', () => handleMcpRequest(REMEMBER, ctx), undefined, abort.signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(loadAllEntries(root, 'default')).toHaveLength(0);
  });

  it('runs the same call to completion while the signal stays quiet', async () => {
    const abort = new AbortController();
    const reply = await runWithRequestId('req-ok', () => handleMcpRequest(REMEMBER, ctx), undefined, abort.signal);
    expect(reply?.error).toBeUndefined();
    expect(loadAllEntries(root, 'default')).toHaveLength(1);
  });
});
