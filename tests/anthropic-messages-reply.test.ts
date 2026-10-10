// sendAnthropicMessage reads its reply under a byte cap and through shape checks, and reports a bad reply as a typed failure.
import { describe, expect, it } from 'vitest';
import { type AnthropicMessageFailure, isPermanentFailure, sendAnthropicMessage } from '../src/util/anthropic-messages.js';

const REPLY_CAP_BYTES = 1024 * 1024;

function send(body: string): ReturnType<typeof sendAnthropicMessage> {
  return sendAnthropicMessage({ apiKey: 'k-test', maxTokens: 10, prompt: 'hi', fetcher: async () => new Response(body, { status: 200 }) });
}

describe('sendAnthropicMessage reply reading', () => {
  it('returns the first text block, trimmed', async () => {
    expect(await send(JSON.stringify({ content: [{ type: 'text', text: '  tea  ' }] }))).toEqual({ ok: true, text: 'tea' });
  });

  it('returns empty text when the reply has no text block', async () => {
    for (const body of ['{}', '{"content":[]}', '{"content":"tea"}', '{"content":[{"type":"tool_use"}]}', '{"content":[null]}']) {
      expect(await send(body)).toEqual({ ok: true, text: '' });
    }
  });

  it('reports a body that is not a JSON object as unreadable', async () => {
    for (const body of ['null', '[]', '"tea"']) {
      expect(await send(body)).toEqual({ ok: false, failure: { kind: 'unreadable', message: 'the reply is not a JSON object' } });
    }
    expect(await send('<html>busy</html>')).toEqual({ ok: false, failure: { kind: 'unreadable', message: 'reply is not JSON' } });
  });

  it('reports a reply over the byte cap as unreadable, even one that holds valid text', async () => {
    const padded = `{"content":[{"type":"text","text":"tea"}]${' '.repeat(REPLY_CAP_BYTES)}}`;
    expect(JSON.parse(padded).content[0].text).toBe('tea');
    expect(await send(padded)).toEqual({ ok: false, failure: { kind: 'unreadable', message: `reply over ${REPLY_CAP_BYTES} bytes` } });
  });
});

describe('sendAnthropicMessage on a non-2xx reply', () => {
  const LEAKED_KEY = `sk-ant-api03-${'a'.repeat(40)}`;

  function failWith(status: number, body: string): ReturnType<typeof sendAnthropicMessage> {
    return sendAnthropicMessage({ apiKey: 'k-test', maxTokens: 10, prompt: 'hi', fetcher: async () => new Response(body, { status }) });
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
});

describe('isPermanentFailure', () => {
  const http = (status: number): AnthropicMessageFailure => ({ kind: 'http', status, detail: '' });

  it('is true for a bad key, no credit, no permission and an unknown model', () => {
    for (const status of [401, 402, 403, 404]) expect(isPermanentFailure(http(status))).toBe(true);
  });

  it('is false for a failure a later call can clear or that belongs to one prompt', () => {
    for (const status of [400, 413, 429, 500, 529]) expect(isPermanentFailure(http(status))).toBe(false);
    expect(isPermanentFailure({ kind: 'request', message: 'fetch failed' })).toBe(false);
    expect(isPermanentFailure({ kind: 'unreadable', message: 'reply is not JSON' })).toBe(false);
  });
});
