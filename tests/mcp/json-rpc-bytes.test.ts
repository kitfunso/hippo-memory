// The bytes of every JSON-RPC reply kind the MCP transports write, pinned as strings so a change to how replies are built cannot move a key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/base/config/config.js';
import { NotFoundError } from '../../src/base/errors/api-errors.js';
import { HttpError, STORE_NOT_PORTED_MESSAGE } from '../../src/base/util/http-util.js';
import { log } from '../../src/base/util/log.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { handleMcpRequest, mcpErrorResponse, type McpContext } from '../../src/surface/mcp/server.js';
import type { McpHost } from '../../src/surface/mcp/protocol.js';
import { startStdioLoop } from '../../src/surface/mcp/stdio.js';
import { TOOLS } from '../../src/surface/mcp/tools.js';
import { cliStdioHost } from '../../src/surface/cli/api-context.js';
import type { HippoStore } from '../../src/store/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { withoutLocalFiles } from '../_helpers/port-only-store.js';
import { captureWrites, fire, recordListeners, stubExit, type Listener } from '../_helpers/process-stubs.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-rpc-bytes-'));
  vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  vi.spyOn(log, 'info').mockImplementation(() => undefined);
  vi.spyOn(log, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function ctx(over: Partial<McpContext> = {}): McpContext {
  return {
    hippoRoot: root,
    tenantId: 'default',
    actor: 'mcp',
    role: 'admin',
    hostAdmin: true,
    store: sqliteStore(root),
    config: loadConfig(root),
    ...over,
  };
}

async function call(
  id: number,
  name: string,
  args: JsonValue | undefined,
  over?: Partial<McpContext>,
): Promise<string> {
  const params: Record<string, JsonValue> = args === undefined ? { name } : { name, arguments: args };
  return JSON.stringify(await handleMcpRequest({ jsonrpc: '2.0', id, method: 'tools/call', params }, ctx(over)));
}

describe('replies built by the dispatcher', () => {
  it('initialize', async () => {
    const reply = JSON.stringify(await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }, undefined));
    expect(reply).toMatch(
      /^\{"jsonrpc":"2.0","id":1,"result":\{"protocolVersion":"2024-11-05","capabilities":\{"tools":\{\}\},"serverInfo":\{"name":"hippo-memory","version":"[^"]+"\}\}\}$/,
    );
  });

  it('tools/list', async () => {
    const reply = JSON.stringify(await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, undefined));
    expect(reply).toBe(`{"jsonrpc":"2.0","id":2,"result":{"tools":${JSON.stringify(TOOLS)}}}`);
  });

  it('a method it does not know, with -32601', async () => {
    const reply = JSON.stringify(await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'no/such' }, undefined));
    expect(reply).toBe('{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found: no/such"}}');
  });

  it('a tool it does not know, with -32602', async () => {
    expect(await call(4, 'nope', {})).toBe(
      '{"jsonrpc":"2.0","id":4,"error":{"code":-32602,"message":"Unknown tool: nope"}}',
    );
  });

  it('arguments that are not an object, with -32602', async () => {
    expect(await call(5, 'hippo_recall', 'text')).toBe(
      '{"jsonrpc":"2.0","id":5,"error":{"code":-32602,"message":"hippo_recall: arguments must be an object"}}',
    );
  });

  it('a tool the store cannot run, with -32603', async () => {
    const store: HippoStore = { ...withoutLocalFiles(sqliteStore(root)), kind: 'other' };
    expect(await call(6, 'hippo_share', {}, { store })).toBe(
      `{"jsonrpc":"2.0","id":6,"error":{"code":-32603,"message":${JSON.stringify(STORE_NOT_PORTED_MESSAGE)}}}`,
    );
  });

  it('a tool the shared store refuses, as a tool result', async () => {
    const config = { ...loadConfig(root), sharedStore: true };
    expect(await call(7, 'hippo_learn', {}, { config })).toBe(
      '{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"hippo_learn is off on a shared store: it reads the server\'s git history"}],"isError":true}}',
    );
  });

  it('arguments that fail validation, as a tool result', async () => {
    expect(await call(8, 'hippo_recall', {})).toMatch(
      /^\{"jsonrpc":"2.0","id":8,"result":\{"content":\[\{"type":"text","text":"Invalid arguments for hippo_recall: [^"]+"\}\],"isError":true\}\}$/,
    );
  });

  it('a tool that ran, as a tool result', async () => {
    expect(await call(9, 'hippo_recall', { query: 'nothing stored yet' })).toMatch(
      /^\{"jsonrpc":"2.0","id":9,"result":\{"content":\[\{"type":"text","text":"[^"]*"\}\]\}\}$/,
    );
  });
});

describe('replies for a request that threw', () => {
  it('a busy store, with -32603 and the busy text', () => {
    expect(JSON.stringify(mcpErrorResponse(10, new HttpError(503, 'store busy, retry'), 'rid-1'))).toBe(
      '{"jsonrpc":"2.0","id":10,"error":{"code":-32603,"message":"store busy, retry"}}',
    );
  });

  it('a typed error keeps its text', () => {
    expect(JSON.stringify(mcpErrorResponse('a', new NotFoundError('Memory not found: x'), 'rid-2'))).toBe(
      '{"jsonrpc":"2.0","id":"a","error":{"code":-32603,"message":"Memory not found: x"}}',
    );
  });

  it('an untyped error is generic and carries the request id', () => {
    expect(JSON.stringify(mcpErrorResponse(11, new Error('disk path /secret'), 'rid-3'))).toBe(
      '{"jsonrpc":"2.0","id":11,"error":{"code":-32603,"message":"internal server error (request id rid-3)","data":{"requestId":"rid-3"}}}',
    );
  });
});

describe('replies the stdio loop writes', () => {
  let stdin: Map<string, Listener[]>;
  let written: string[];

  beforeEach(() => {
    stdin = recordListeners(process.stdin, 'on');
    recordListeners(process.stdout, 'on');
    recordListeners(process, 'on');
    written = captureWrites(process.stdout);
    captureWrites(process.stderr);
    stubExit();
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  const feed = (data: string | Buffer): void => fire(stdin, 'data', Buffer.from(data));

  it('a frame that is not JSON, with -32700', () => {
    startStdioLoop(cliStdioHost());
    feed('not json\n');
    expect(written).toEqual(['{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}\n']);
  });

  it('a frame with an id and no method, with -32600', () => {
    startStdioLoop(cliStdioHost());
    feed('{"jsonrpc":"2.0","id":12}\n');
    expect(written).toEqual([
      '{"jsonrpc":"2.0","id":12,"error":{"code":-32600,"message":"Invalid Request: method must be a string"}}\n',
    ]);
  });

  it('a frame over 1 MB, with -32700', () => {
    startStdioLoop(cliStdioHost());
    const declared = 2 * 1024 * 1024;
    feed(`Content-Length: ${declared}\r\n\r\n`);
    // The refused body is dropped as it arrives, so the loop reads the next frame as itself.
    feed(Buffer.alloc(declared, 0x78));
    expect(written).toEqual([
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error: frame exceeds 1MB"}}\n',
    ]);
  });

  it('a call past its deadline, with -32001 and the request id, and the late reply is dropped', async () => {
    // The call is held until the reply is out, so no timer race decides the order. The deadline stays real: a faked
    // timer fires outside the request's async scope and drops the request id.
    vi.stubEnv('HIPPO_REQUEST_DEADLINE_MS', '40');
    const real = cliStdioHost();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = false;
    const slow: McpHost = {
      contextFor: (hippoRoot, tenantId) => real.contextFor(hippoRoot, tenantId),
      runRequest: async (run) => {
        await held;
        ran = true;
        return run();
      },
    };
    startStdioLoop(slow);
    feed('{"jsonrpc":"2.0","id":13,"method":"tools/list"}\n');
    await vi.waitFor(() => expect(written).toHaveLength(1), { timeout: 5000 });
    expect(ran).toBe(false);
    expect(written[0]).toMatch(
      /^\{"jsonrpc":"2.0","id":13,"error":\{"code":-32001,"message":"Request timed out: tools\/list did not finish within 40 ms; a write it started may or may not be saved","data":\{"requestId":"[0-9a-f-]{36}"\}\}\}\n$/,
    );
    release();
    fire(stdin, 'end');
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0), { timeout: 5000 });
    expect(ran).toBe(true);
    expect(written).toHaveLength(1);
  });
});
