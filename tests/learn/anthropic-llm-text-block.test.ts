// A thinking model puts its thinking block first; the reply is the first block of type text.
import { describe, expect, it } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';

function replying(content: unknown[]): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ content }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('the Anthropic port reads the reply text', () => {
  it('skips a thinking block before the text', async () => {
    const llm = anthropicLlm({
      apiKey: 'test-key',
      fetcher: replying([
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: ' [{"i": 0, "s": [1]}] ' },
      ]),
    });
    expect(await llm.send({ maxTokens: 64, prompt: 'p' })).toEqual({ ok: true, text: '[{"i": 0, "s": [1]}]' });
  });

  it('reports empty when no block is text', async () => {
    const llm = anthropicLlm({ apiKey: 'test-key', fetcher: replying([{ type: 'thinking', thinking: 'x' }]) });
    expect(await llm.send({ maxTokens: 64, prompt: 'p' })).toEqual({ ok: false, failure: { kind: 'empty' } });
  });
});
