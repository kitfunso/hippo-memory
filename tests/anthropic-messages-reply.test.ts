// sendAnthropicMessage reads its reply under a byte cap and through shape checks, and reports a bad reply as a typed failure.
import { describe, expect, it } from 'vitest';
import { sendAnthropicMessage } from '../src/util/anthropic-messages.js';

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
