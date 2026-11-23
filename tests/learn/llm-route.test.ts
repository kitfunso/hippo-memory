// Which model a process calls: the endpoint wins, a half-set or unsafe setting is refused and never falls back to Anthropic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPermanentFailure, type LlmReply } from '../../src/base/ports/llm.js';
import { llmFromEnv } from '../../src/infra/ports.js';
import { llmRoute } from '../../src/infra/llm-route.js';

const BASE = 'http://127.0.0.1:9/v1';
const ZEBRA = 'zebra-7731';

afterEach(() => {
  vi.unstubAllEnvs();
});

function recorder() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })));
}

function ask(llm: ReturnType<typeof llmFromEnv>): Promise<LlmReply> {
  if (!llm) throw new Error('expected an Llm');
  return llm.send({ maxTokens: 10, prompt: 'hi' });
}

function endpointEnv(extra: Record<string, string> = {}): void {
  vi.stubEnv('HIPPO_LLM_BASE_URL', BASE);
  vi.stubEnv('HIPPO_LLM_MODEL', 'm');
  for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
}

async function expectRefused(reason: string | RegExp): Promise<void> {
  const route = llmRoute();
  expect(route.kind).toBe('refused');
  if (route.kind !== 'refused') return;
  expect(route.reason).toMatch(reason);
  const fetcher = recorder();
  const reply = await ask(llmFromEnv(fetcher));
  if (reply.ok) throw new Error('expected a refusal');
  expect(reply.failure).toEqual({ kind: 'config', message: route.reason });
  expect(isPermanentFailure(reply.failure)).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
}

describe('llmRoute and llmFromEnv', () => {
  it('sends to the endpoint, and only there, when both routes are set', async () => {
    endpointEnv({ ANTHROPIC_API_KEY: 'k-anthropic' });
    expect(llmRoute()).toEqual({ kind: 'endpoint', endpoint: BASE, model: 'm', plainHttp: true });
    const fetcher = recorder();
    await ask(llmFromEnv(fetcher));
    expect(fetcher.mock.calls.map((c) => String(c[0]))).toEqual([`${BASE}/chat/completions`]);
  });

  it('refuses a base URL with no model', async () => {
    vi.stubEnv('HIPPO_LLM_BASE_URL', BASE);
    await expectRefused(/HIPPO_LLM_MODEL/);
  });

  it.each(['HIPPO_LLM_MODEL', 'HIPPO_LLM_API_KEY'])(
    'refuses %s without a base URL, even with an Anthropic key',
    async (name) => {
      vi.stubEnv(name, 'm');
      vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
      await expectRefused(/HIPPO_LLM_BASE_URL/);
    },
  );

  it('refuses plain http to a private host unless HIPPO_LLM_ALLOW_HTTP is set', async () => {
    vi.stubEnv('HIPPO_LLM_BASE_URL', 'http://llm.internal:8000/v1');
    vi.stubEnv('HIPPO_LLM_MODEL', 'm');
    await expectRefused(/HIPPO_LLM_ALLOW_HTTP/);
    vi.stubEnv('HIPPO_LLM_ALLOW_HTTP', '1');
    expect(llmRoute()).toEqual({
      kind: 'endpoint',
      endpoint: 'http://llm.internal:8000/v1',
      model: 'm',
      plainHttp: true,
    });
  });

  it('reports https as not plain', () => {
    vi.stubEnv('HIPPO_LLM_BASE_URL', 'https://llm.internal/v1/');
    vi.stubEnv('HIPPO_LLM_MODEL', 'm');
    expect(llmRoute()).toEqual({ kind: 'endpoint', endpoint: 'https://llm.internal/v1', model: 'm', plainHttp: false });
  });

  it.each(['https://llm.internal/v1?api-version=1', 'https://llm.internal/v1#frag'])(
    'refuses a base URL with a query or a fragment: %s',
    async (base) => {
      vi.stubEnv('HIPPO_LLM_BASE_URL', base);
      vi.stubEnv('HIPPO_LLM_MODEL', 'm');
      await expectRefused('HIPPO_LLM_BASE_URL must not carry a query or a fragment');
    },
  );

  it('uses Anthropic for a key alone, and no model for nothing', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'k-anthropic');
    expect(llmRoute()).toEqual({ kind: 'anthropic' });
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(llmRoute()).toEqual({ kind: 'off' });
    expect(llmFromEnv()).toBeUndefined();
  });

  it('never holds the key in the route', () => {
    endpointEnv({ HIPPO_LLM_API_KEY: 'k-secret-endpoint' });
    expect(JSON.stringify(llmRoute())).not.toContain('k-secret-endpoint');
  });
});

describe('keys are checked when they are read', () => {
  it.each([
    ['HIPPO_LLM_API_KEY', true],
    ['ANTHROPIC_API_KEY', false],
  ])('refuses a %s a header cannot carry, with no request and no echo', async (name, withEndpoint) => {
    if (withEndpoint) endpointEnv();
    vi.stubEnv(name, `${ZEBRA}\nb`);
    const route = llmRoute();
    expect(route).toEqual({ kind: 'refused', reason: `${name} has characters a header cannot carry` });
    expect(JSON.stringify(route)).not.toContain(ZEBRA);
    await expectRefused(`${name} has characters a header cannot carry`);
  });

  it('refuses an Anthropic key with a space inside', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'a b');
    expect(llmRoute().kind).toBe('refused');
  });

  it('trims an Anthropic key, so a key file newline keeps working', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '  k-1\n');
    expect(llmRoute()).toEqual({ kind: 'anthropic' });
    const fetcher = recorder();
    await ask(llmFromEnv(fetcher));
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('x-api-key')).toBe('k-1');
  });

  it('does not read ANTHROPIC_API_KEY on the endpoint branch', () => {
    endpointEnv({ ANTHROPIC_API_KEY: 'a b' });
    expect(llmRoute().kind).toBe('endpoint');
  });
});
