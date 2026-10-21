// The Anthropic Llm reads its reply under a byte cap and through shape checks, and reports a bad reply as a typed failure.
import { describe, expect, it, vi } from 'vitest';
import { isPermanentFailure, llmFailureFields, type LlmFailure, type LlmReply } from '../../src/base/ports/llm.js';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';

/** One prompt through an Anthropic Llm whose network is `fetcher`. */
function sendVia(fetcher: typeof fetch): Promise<LlmReply> {
  return anthropicLlm({ apiKey: 'k-test', fetcher }).send({ maxTokens: 10, prompt: 'hi' });
}

const REPLY_CAP_BYTES = 1024 * 1024;

function send(body: string): Promise<LlmReply> {
  return sendVia(async () => new Response(body, { status: 200 }));
}

describe('anthropicLlm reply reading', () => {
  it('returns the first text block, trimmed', async () => {
    expect(await send(JSON.stringify({ content: [{ type: 'text', text: '  tea  ' }] }))).toEqual({
      ok: true,
      text: 'tea',
    });
  });

  it('reports a reply with no text block as an empty failure, not as ok', async () => {
    for (const body of [
      '{}',
      '{"content":[]}',
      '{"content":"tea"}',
      '{"content":[{"type":"tool_use"}]}',
      '{"content":[null]}',
    ]) {
      expect(await send(body)).toEqual({ ok: false, failure: { kind: 'empty' } });
    }
  });

  it('reports a body that is not a JSON object as unreadable', async () => {
    for (const body of ['null', '[]', '"tea"']) {
      expect(await send(body)).toEqual({
        ok: false,
        failure: { kind: 'unreadable', message: 'the reply is not a JSON object' },
      });
    }
    expect(await send('<html>busy</html>')).toEqual({
      ok: false,
      failure: { kind: 'unreadable', message: 'reply is not JSON' },
    });
  });

  it('reports a reply over the byte cap as unreadable, even one that holds valid text', async () => {
    const padded = `{"content":[{"type":"text","text":"tea"}]${' '.repeat(REPLY_CAP_BYTES)}}`;
    expect(JSON.parse(padded).content[0].text).toBe('tea');
    expect(await send(padded)).toEqual({
      ok: false,
      failure: { kind: 'unreadable', message: `reply over ${REPLY_CAP_BYTES} bytes` },
    });
  });
});

describe('anthropicLlm on a non-2xx reply', () => {
  const LEAKED_KEY = `sk-ant-api03-${'a'.repeat(40)}`;

  function failWith(status: number, body: string): Promise<LlmReply> {
    return sendVia(async () => new Response(body, { status }));
  }

  it('keeps the start of the error body on one line, capped, with key-shaped text masked', async () => {
    const cause = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    const reply = await failWith(401, `${cause}\n  echoed ${LEAKED_KEY}\n${'x'.repeat(5000)}`);
    if (reply.ok || reply.failure.kind !== 'http') throw new Error('expected an http failure');
    expect(reply.failure.status).toBe(401);
    expect(reply.failure.detail.startsWith(`${cause} echoed `)).toBe(true);
    expect(reply.failure.detail).not.toContain(LEAKED_KEY);
    expect(reply.failure.detail).not.toMatch(/\n/);
    expect(reply.failure.detail.length).toBeLessThanOrEqual(256);
  });

  it('reports an empty detail for an empty body', async () => {
    expect(await failWith(404, '')).toEqual({ ok: false, failure: { kind: 'http', status: 404, detail: '' } });
  });

  it('warns with the error fields when the body cannot be read, and keeps the empty detail', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const broken = new ReadableStream<Uint8Array>({
        pull: () => {
          throw new Error('socket reset');
        },
      });
      const reply = await sendVia(async () => new Response(broken, { status: 400 }));
      expect(reply).toEqual({ ok: false, failure: { kind: 'http', status: 400, detail: '' } });
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('could not read the error body of a 400 reply');
      expect(written).toContain('errorClass=');
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('anthropicLlm on a transport failure', () => {
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

  it("keeps a transport failure's error, so the log line has its class, errno name and cause chain", async () => {
    const reply = await sendVia(async () => {
      throw new TypeError('fetch failed', { cause: reset });
    });
    if (reply.ok || reply.failure.kind !== 'request') throw new Error('expected a request failure');
    expect(reply.failure.message).toBe('fetch failed');
    expect(llmFailureFields(reply.failure)).toMatchObject({
      llmFailure: 'request',
      errorClass: 'TypeError',
      errno: 'ECONNRESET',
      cause: 'Error: read ECONNRESET',
    });
  });

  it('names the kind of every failure, and the status of an HTTP one, with no thrown error behind it', () => {
    expect(llmFailureFields({ kind: 'http', status: 500, detail: 'busy' })).toEqual({
      llmFailure: 'http',
      status: 500,
    });
    expect(llmFailureFields({ kind: 'request', message: 'fetch failed' })).toEqual({ llmFailure: 'request' });
    expect(llmFailureFields({ kind: 'unreadable', message: 'reply is not JSON' })).toEqual({
      llmFailure: 'unreadable',
    });
    expect(llmFailureFields({ kind: 'empty' })).toEqual({ llmFailure: 'empty' });
  });
});

describe('isPermanentFailure', () => {
  const http = (status: number): LlmFailure => ({ kind: 'http', status, detail: '' });

  it('is true for a bad key, no credit, no permission and an unknown model', () => {
    for (const status of [401, 402, 403, 404]) expect(isPermanentFailure(http(status))).toBe(true);
  });

  it('is false for a failure a later call can clear or that belongs to one prompt', () => {
    for (const status of [400, 413, 429, 500, 529]) expect(isPermanentFailure(http(status))).toBe(false);
    expect(isPermanentFailure({ kind: 'request', message: 'fetch failed' })).toBe(false);
    expect(isPermanentFailure({ kind: 'unreadable', message: 'reply is not JSON' })).toBe(false);
  });
});
