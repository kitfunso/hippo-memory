// A message call stores nothing on the far side, so a dropped connection is replayed as a 5xx is.
import { describe, expect, it, vi } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';

const reset = (): Error =>
  Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  });

describe('anthropicLlm over a connection that resets', () => {
  it('sends the POST again and returns the text of the second attempt', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(reset())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ content: [{ type: 'text', text: 'hello' }] }), { status: 200 }),
      );
    const reply = await anthropicLlm({ apiKey: 'k-reset-test', fetcher }).send({ prompt: 'hi', maxTokens: 10 });
    expect(reply).toEqual({ ok: true, text: 'hello' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
