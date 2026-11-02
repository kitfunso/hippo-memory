// A thinking model puts its thinking block first; the reply is the first block of type text.
import { describe, expect, it } from 'vitest';
import { anthropicLlm } from '../../src/infra/anthropic-llm.js';

/** The usage block as the API sends it, or a malformed one. */
interface WireUsage {
  readonly input_tokens: number | string;
  readonly output_tokens: number;
}

function replying(content: unknown[], usage?: WireUsage): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ content, usage }), { status: 200, headers: { 'content-type': 'application/json' } });
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

  it('returns the billed tokens, on an empty reply too', async () => {
    const usage = { input_tokens: 812, output_tokens: 37 };
    const text = anthropicLlm({ apiKey: 'test-key', fetcher: replying([{ type: 'text', text: '[]' }], usage) });
    expect(await text.send({ maxTokens: 64, prompt: 'p' })).toEqual({
      ok: true,
      text: '[]',
      usage: { inputTokens: 812, outputTokens: 37 },
    });
    const empty = anthropicLlm({ apiKey: 'test-key', fetcher: replying([{ type: 'thinking', thinking: 'x' }], usage) });
    expect(await empty.send({ maxTokens: 64, prompt: 'p' })).toEqual({
      ok: false,
      failure: { kind: 'empty' },
      usage: { inputTokens: 812, outputTokens: 37 },
    });
  });

  it('leaves usage out when the reply names none or a malformed one', async () => {
    const llm = anthropicLlm({
      apiKey: 'test-key',
      fetcher: replying([{ type: 'text', text: '[]' }], { input_tokens: '812', output_tokens: 37 }),
    });
    expect(await llm.send({ maxTokens: 64, prompt: 'p' })).toEqual({ ok: true, text: '[]' });
  });
});
