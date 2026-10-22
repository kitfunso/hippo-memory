// Failed auth, a busy MCP store and a degraded judge reach stderr at the default (warn) threshold.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { logRequestFailure } from '../../src/surface/server/request.js';
import { mcpErrorResponse } from '../../src/surface/mcp/protocol.js';
import { runWithRequestId } from '../../src/base/util/request-scope.js';
import { StoreBusyError } from '../../src/store/port.js';
import { HttpError } from '../../src/base/util/http-util.js';
import { judgeAll } from '../../src/entry/eval-scripts.js';
import { createLocalEmbedder } from '../../src/infra/local-embedder.js';
import { installOpencodePlugin } from '../../src/surface/hooks-install/opencode.js';
import { resolveOpencodePluginPath } from '../../src/surface/hooks-install/opencode.js';
import * as fs from 'node:fs';
import { withFakeHome } from '../_helpers/with-fake-home.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

let lines: string[];

beforeEach(() => {
  vi.stubEnv('HIPPO_LOG', undefined);
  lines = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const fakeReq = Object.assign(new IncomingMessage(new Socket()), { method: 'POST', url: '/v1/memories?x=1' });

describe('failed requests at the default threshold', () => {
  it('writes a warn line with the request id for a 401 and a 403', () => {
    runWithRequestId('req-401', () => logRequestFailure(fakeReq, new HttpError(401, 'unauthorized'), 401));
    runWithRequestId('req-403', () => logRequestFailure(fakeReq, new HttpError(403, 'forbidden'), 403));
    expect(lines.join('')).toMatch(/warn: POST unmatched failed: unauthorized .*requestId=req-401 status=401/);
    expect(lines.join('')).toMatch(/requestId=req-403/);
  });

  it('keeps a 404 at info, below the default threshold', () => {
    logRequestFailure(fakeReq, new HttpError(404, 'nope'), 404);
    expect(lines).toEqual([]);
  });

  it('logs a busy MCP store at warn and a typed non-500 at info, both naming the tool', () => {
    mcpErrorResponse(1, new StoreBusyError(), 'req-busy', 'tools/call hippo_recall');
    expect(lines.join('')).toMatch(/warn: mcp request \(tools\/call hippo_recall\) failed/);
    lines.length = 0;
    vi.stubEnv('HIPPO_LOG', 'info');
    mcpErrorResponse(2, new HttpError(404, 'missing'), 'req-404', 'tools/call hippo_get');
    expect(lines.join('')).toMatch(/info: mcp request \(tools\/call hippo_get\) failed.*requestId=req-404/);
  });
});

describe('judge failures', () => {
  it('warns with the status and a body snippet on a non-2xx, never the key', async () => {
    const fetcher: typeof fetch = async () => new Response('bad credentials', { status: 401 });
    const out = await judgeAll(['a durable fact about the deploy'], { apiKey: 'sk-secret-key', fetcher });
    expect(out).toEqual([null]);
    const text = lines.join('');
    expect(text).toMatch(/warn: judge: non-2xx reply .*status=401 body=bad credentials/);
    expect(text).not.toContain('sk-secret-key');
  });

  it('warns with the error class on a transport error', async () => {
    const fetcher: typeof fetch = async () => {
      throw new TypeError('socket hang up');
    };
    await judgeAll(['a durable fact about the deploy'], { apiKey: 'k', fetcher });
    expect(lines.join('')).toMatch(/warn: judge: request failed: socket hang up.*errorClass=TypeError/);
  });
});

describe('failures that used to log at debug', () => {
  it('warns once when a judge reply is not readable, then goes quiet', async () => {
    const fetcher: typeof fetch = async () => new Response('<html>busy</html>', { status: 200 });
    await judgeAll(['a durable fact about the deploy', 'another durable fact about the deploy'], {
      apiKey: 'k',
      fetcher,
      concurrency: 1,
    });
    expect(lines.join('').match(/warn: judge: unreadable response/g)).toHaveLength(1);
  });

  it('warns once when a local embedding fails, and still answers []', async () => {
    const pipeline = async () => async (): Promise<{ data: number[] }> => {
      throw new Error('onnx runtime crashed');
    };
    const embedder = createLocalEmbedder({
      installed: () => true,
      load: async () => ({ name: 'stand-in', mod: { pipeline } }),
    });
    expect(await embedder.embed('one', 'Xenova/test-model')).toEqual([]);
    expect(await embedder.embed('two', 'Xenova/test-model')).toEqual([]);
    expect(
      lines.join('').match(/warn: local embedding with Xenova\/test-model failed: onnx runtime crashed/g),
    ).toHaveLength(1);
  });
});

describe('generated opencode plugin', () => {
  it('writes the exit code to stderr when session-end fails, and stays non-fatal', async () => {
    const env = withFakeHome('hippo-oc-warn-');
    try {
      installOpencodePlugin();
      const src = fs.readFileSync(resolveOpencodePluginPath(), 'utf8');
      const exported = /export const (\w+)/.exec(src)?.[1];
      expect(exported).toMatch(/^\w+$/);
      const errors: string[] = [];
      const make = new Function('console', `${src.replace('export const', 'const')}; return ${exported};`);
      const plugin = await make({ error: (m: string) => errors.push(m) })({
        $: () => ({ quiet: () => ({ nothrow: async () => ({ exitCode: 3 }) }) }),
      });
      await plugin.event({ event: { type: 'session.idle' } });
      expect(errors).toEqual(['[hippo] session-end exited 3']);
    } finally {
      env.cleanup();
    }
  });
});
