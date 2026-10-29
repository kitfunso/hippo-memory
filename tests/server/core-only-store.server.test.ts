// serve() on a store with only the core port's members: remember, recall, context, auth and audit answer, and every
// local path (a group or hippo.db route, a webhook, a group MCP tool) answers the one refusal.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { STORE_NOT_PORTED_MESSAGE } from '../../src/base/errors/http-errors.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { TOOLS } from '../../src/surface/mcp/tools.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { V1_ROWS } from '../_helpers/v1-route-rows.js';
import { requestLine, rpc } from '../_helpers/other-store-server.js';
import { portOnlyStore } from '../_helpers/port-only-store.js';
import { seedTwoTenants, type TwoTenantFixture } from '../_helpers/store-conformance.js';

// The tools that run on the core port alone; every other tool is a local feature.
const CORE_TOOLS = new Set(['hippo_recall', 'hippo_remember', 'hippo_outcome', 'hippo_context']);

const LOCAL_ROWS = V1_ROWS.filter(
  ({ route }) =>
    route.auth === 'webhook-signature' ||
    route.storeReady !== undefined ||
    route.needsHippoDbMark !== undefined ||
    route.hippoDb === true,
).map(({ key }) => requestLine(key));

describe('serve() on a store with only the core members', () => {
  let fixture: TwoTenantFixture;
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_CALLER_RPS', '0');
    fixture = seedTwoTenants();
    handle = await serve({ hippoRoot: fixture.dir, port: 0, store: portOnlyStore(fixture.dir) });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  const send = async (method: string, path: string, body: JsonValue = {}) => {
    const res = await fetch(`${handle.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${fixture.tokens.adminA}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };

  it('remembers, recalls, builds context, mints keys and lists the audit rows', async () => {
    const remembered = await send('POST', '/v1/memories', { content: 'the eu cluster deploys on friday', force: true });
    expect(remembered.status).toBe(200);
    const id = /"id":"(mem_[^"]+)"/.exec(remembered.text)?.[1] ?? 'none';
    expect((await send('GET', '/v1/memories?q=cluster')).text).toContain(id);
    expect((await send('GET', '/v1/context?q=cluster&project=p')).status).toBe(200);
    const minted = await send('POST', '/v1/auth/keys', { label: 'core-only' });
    expect(minted.status).toBe(200);
    const keyId = /"keyId":"(hk_[^"]+)"/.exec(minted.text)?.[1] ?? 'none';
    expect((await send('GET', '/v1/auth/keys')).text).toContain(keyId);
    const audit = await send('GET', '/v1/audit');
    expect([audit.status, audit.text.includes(id), audit.text.includes(keyId)]).toEqual([200, true, true]);
  });

  it('answers the one refusal on every local route', async () => {
    expect(LOCAL_ROWS.length).toBeGreaterThan(0);
    for (const line of LOCAL_ROWS) {
      const [method = '', path = ''] = line.split(' ');
      const { status, text } = await send(method, path);
      expect({ line, status, body: JSON.parse(text) }).toEqual({
        line,
        status: 501,
        body: { error: STORE_NOT_PORTED_MESSAGE },
      });
    }
  });

  it('hides every local MCP tool and refuses a call to one', async () => {
    const mcp = async (body: string) => {
      const res = await fetch(`${handle.url}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.tokens.adminA}`,
          'content-type': 'application/json',
          'x-hippo-project': 'p',
        },
        body,
      });
      return res.text();
    };
    const listed = (await mcp(rpc('tools/list'))).match(/"name":"(hippo_\w+)"/g) ?? [];
    expect(listed.map((n) => n.slice(8, -1)).sort()).toEqual([...CORE_TOOLS].sort());
    const local = TOOLS.map(({ name }) => name).filter((name) => !CORE_TOOLS.has(name));
    for (const name of local) {
      const reply = await mcp(rpc('tools/call', { name, arguments: {} }));
      expect({ name, refused: reply.includes(STORE_NOT_PORTED_MESSAGE) }).toEqual({ name, refused: true });
    }
  });
});
