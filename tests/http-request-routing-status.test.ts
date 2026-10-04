// Pins the status and body the HTTP daemon answers for routes outside the /v1 table, so splitting handleRequest cannot move them.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { serve, type ServerHandle } from '../src/server.js';

const handles: ServerHandle[] = [];
const dirs: string[] = [];

async function boot(): Promise<ServerHandle> {
  const home = mkdtempSync(join(tmpdir(), 'hippo-http-routing-'));
  dirs.push(home);
  const root = join(home, '.hippo');
  initStore(root);
  const handle = await serve({ hippoRoot: root, port: 0 });
  handles.push(handle);
  return handle;
}

async function hit(handle: ServerHandle, path: string, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(`${handle.url}${path}`, init);
  return { status: res.status, body: await res.text() };
}

function post(body: string, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body };
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('HTTP routing outside the /v1 table', () => {
  it('answers health, unknown routes, encoded slashes and the MCP POST edge cases', async () => {
    const h = await boot();

    const health = await hit(h, '/health');
    expect(health.status).toBe(200);
    expect(Object.keys(JSON.parse(health.body)).sort()).toMatchInlineSnapshot(`
      [
        "audit_write_failures",
        "ok",
        "pid",
        "started_at",
        "version",
      ]
    `);

    expect(await hit(h, '/nope')).toMatchInlineSnapshot(`
      {
        "body": "{"error":"not found"}",
        "status": 404,
      }
    `);
    expect(await hit(h, '/v1/nope')).toMatchInlineSnapshot(`
      {
        "body": "{"error":"not found"}",
        "status": 404,
      }
    `);
    expect(await hit(h, '/health', { method: 'POST' })).toMatchInlineSnapshot(`
      {
        "body": "{"error":"not found"}",
        "status": 404,
      }
    `);
    expect(await hit(h, '/v1%2Fmemories')).toMatchInlineSnapshot(`
      {
        "body": "{"error":"URL-encoded slash (%2F) not allowed in path segments"}",
        "status": 400,
      }
    `);

    expect(await hit(h, '/mcp', post('not json'))).toMatchInlineSnapshot(`
      {
        "body": "{"error":"invalid JSON-RPC body"}",
        "status": 400,
      }
    `);
    expect(await hit(h, '/mcp', post('{"jsonrpc":"2.0","id":1}'))).toMatchInlineSnapshot(`
      {
        "body": "{"error":"JSON-RPC body must include a method string"}",
        "status": 400,
      }
    `);
    expect(await hit(h, '/mcp', post('[1,2]'))).toMatchInlineSnapshot(`
      {
        "body": "{"error":"JSON-RPC body must include a method string"}",
        "status": 400,
      }
    `);
    expect(await hit(h, '/mcp', post('{"jsonrpc":"2.0","method":"notifications/initialized"}'))).toMatchInlineSnapshot(`
      {
        "body": "",
        "status": 202,
      }
    `);
    expect(await hit(h, '/mcp', post('{"jsonrpc":"2.0","id":7,"method":"no/such"}'))).toMatchInlineSnapshot(`
      {
        "body": "{"jsonrpc":"2.0","id":7,"error":{"code":-32601,"message":"Method not found: no/such"}}",
        "status": 200,
      }
    `);
    expect(await hit(h, '/mcp', post('{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"hippo_recall","arguments":{"query":"x","scorer_window":"abc"}}}')))
      .toMatchInlineSnapshot(`
        {
          "body": "{"jsonrpc":"2.0","id":8,"error":{"code":-32603,"message":"scorerWindow must be a positive integer; got NaN"}}",
          "status": 200,
        }
      `);
    expect(await hit(h, '/mcp', post('{"jsonrpc":"2.0","id":9,"method":"tools/list"}', { authorization: 'Bearer hk_not_a_real_key' })))
      .toMatchInlineSnapshot(`
        {
          "body": "{"error":"invalid api key"}",
          "status": 401,
        }
      `);
    expect(await hit(h, '/mcp/stream', { headers: { authorization: 'Bearer hk_not_a_real_key' } })).toMatchInlineSnapshot(`
      {
        "body": "{"error":"invalid api key"}",
        "status": 401,
      }
    `);
  });

  it('routes the connector webhooks to their HMAC handlers, which 404 without a signing secret', async () => {
    vi.stubEnv('SLACK_SIGNING_SECRET', '');
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
    const h = await boot();
    expect(await hit(h, '/v1/connectors/slack/events', post('{}'))).toMatchInlineSnapshot(`
      {
        "body": "{"error":"not found"}",
        "status": 404,
      }
    `);
    expect(await hit(h, '/v1/connectors/github/events', post('{}'))).toMatchInlineSnapshot(`
      {
        "body": "{"error":"not found"}",
        "status": 404,
      }
    `);
  });

  it('rate-limits /v1 and /mcp per client before routing, and never /health', async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0.5');
    const h = await boot();
    expect((await hit(h, '/v1/nope')).status).toBe(404);
    expect(await hit(h, '/mcp', post('not json'))).toMatchInlineSnapshot(`
      {
        "body": "{"error":"rate limit exceeded"}",
        "status": 429,
      }
    `);
    expect((await hit(h, '/health')).status).toBe(200);
  });
});
