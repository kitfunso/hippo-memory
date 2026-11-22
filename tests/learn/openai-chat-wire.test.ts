// The OpenAI-compatible Llm over a real local server: request bytes, reply mapping, and no reply text or key in any failure.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPermanentFailure, type LlmFailure, type LlmReply } from '../../src/base/ports/llm.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { openAiChatLlm } from '../../src/infra/openai-chat-llm.js';
import { extractFacts } from '../../src/domain/learn/extract.js';

interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Stub {
  baseUrl: URL;
  requests: Recorded[];
}

const ZEBRA = 'zebra-7731';
const stubs: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of stubs.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface StubAnswer {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

async function startStub(reply: (req: Recorded) => StubAnswer): Promise<Stub> {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const seen: Recorded = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(seen);
      const answer = reply(seen);
      res.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
      res.end(answer.body);
    });
  });
  stubs.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: listen() was given a TCP port, so address() is AddressInfo, never a pipe name.
  const { port } = server.address() as AddressInfo;
  return { baseUrl: new URL(`http://127.0.0.1:${port}/v1/`), requests };
}

const replying =
  (content: JsonValue, extra: { [key: string]: JsonValue } = {}) =>
  () => ({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content } }], ...extra }),
  });

function ask(stub: Stub, apiKey?: string): Promise<LlmReply> {
  return openAiChatLlm({ baseUrl: stub.baseUrl, model: 'local-model', apiKey }).send({
    model: 'claude-sonnet-4-6',
    maxTokens: 1200,
    prompt: 'hello there',
  });
}

function chainText(err: Error): string {
  return [err.name, err.message, err.stack ?? '', err.cause instanceof Error ? chainText(err.cause) : ''].join('\n');
}

/** Every character of a failure, its cause chain included. */
function failureText(failure: LlmFailure): string {
  const cause = 'cause' in failure && failure.cause instanceof Error ? chainText(failure.cause) : '';
  return `${JSON.stringify(failure)}\n${cause}`;
}

function replyText(reply: LlmReply): string {
  return reply.ok ? JSON.stringify(reply) : failureText(reply.failure);
}

function failureOf(reply: LlmReply): LlmFailure {
  if (reply.ok) throw new Error('expected a failure');
  return reply.failure;
}

describe('openAiChatLlm request', () => {
  it('posts the endpoint model, not the caller model, with a Bearer key', async () => {
    const stub = await startStub(replying('facts'));
    await ask(stub, 'k-endpoint');
    expect(stub.requests).toHaveLength(1);
    const [req] = stub.requests;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer k-endpoint');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual({
      model: 'local-model',
      max_tokens: 1200,
      messages: [{ role: 'user', content: 'hello there' }],
    });
  });

  it('sends no authorization header without a key', async () => {
    const stub = await startStub(replying('facts'));
    await ask(stub);
    expect(stub.requests[0].headers.authorization).toBeUndefined();
  });
});

describe('openAiChatLlm reply mapping', () => {
  it('returns the trimmed text and maps integer usage', async () => {
    const stub = await startStub(replying('  facts  ', { usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    expect(await ask(stub)).toEqual({ ok: true, text: 'facts', usage: { inputTokens: 7, outputTokens: 3 } });
  });

  it.each([
    ['no usage block', {}],
    ['a non-integer count', { usage: { prompt_tokens: 7.5, completion_tokens: 3 } }],
    ['a missing count', { usage: { prompt_tokens: 7 } }],
    ['a usage that is not an object', { usage: 'many' }],
  ])('leaves usage undefined for %s', async (_label, extra) => {
    const stub = await startStub(replying('facts', extra));
    const reply = await ask(stub);
    expect(reply).toEqual({ ok: true, text: 'facts' });
    expect(reply).not.toHaveProperty('usage');
  });

  it.each([
    ['null', null],
    ['a number', 7],
    ['an array', ['facts']],
  ])('reports content that is %s as unreadable with a fixed text', async (_label, content) => {
    const stub = await startStub(replying(content));
    expect(await ask(stub)).toEqual({
      ok: false,
      failure: { kind: 'unreadable', message: 'the reply held no choices[0].message.content string' },
    });
  });

  it('reports a reply with no choices as unreadable', async () => {
    const stub = await startStub(() => ({ status: 200, body: '{"choices":[]}' }));
    expect(failureOf(await ask(stub)).kind).toBe('unreadable');
  });

  it('reports an empty string as an empty failure', async () => {
    const stub = await startStub(replying(''));
    expect(await ask(stub)).toEqual({ ok: false, failure: { kind: 'empty' } });
  });

  it('reports a body that is not a JSON object as unreadable', async () => {
    const stub = await startStub(() => ({ status: 200, body: '[]' }));
    expect(await ask(stub)).toEqual({
      ok: false,
      failure: { kind: 'unreadable', message: 'the reply is not a JSON object' },
    });
  });
});

describe('openAiChatLlm on a failed reply', () => {
  it.each([401, 402, 403, 404])('gives an http failure for %i that stops a looping caller', async (status) => {
    const stub = await startStub(() => ({ status, body: `{"error":"${ZEBRA}"}` }));
    const failure = failureOf(await ask(stub));
    expect(failure).toMatchObject({ kind: 'http', status });
    expect(isPermanentFailure(failure)).toBe(true);
    expect(failureText(failure)).not.toContain(ZEBRA);
  });

  it('gives a fixed detail per status and none for the rest', async () => {
    const details: Record<number, string> = {};
    for (const status of [401, 403, 402, 404, 400]) {
      const stub = await startStub(() => ({ status, body: 'x' }));
      const failure = failureOf(await ask(stub));
      if (failure.kind !== 'http') throw new Error('expected an http failure');
      details[status] = failure.detail;
    }
    expect(details).toEqual({
      401: 'the endpoint refused the key (HIPPO_LLM_API_KEY)',
      403: 'the endpoint refused the key (HIPPO_LLM_API_KEY)',
      402: 'the endpoint asked for payment',
      404: 'no such path or model at the endpoint (HIPPO_LLM_BASE_URL, HIPPO_LLM_MODEL)',
      400: '',
    });
  });

  it('is not permanent for a 500', async () => {
    const stub = await startStub(() => ({ status: 500, body: '{}' }));
    const failure = failureOf(await ask(stub));
    expect(failure).toMatchObject({ kind: 'http', status: 500 });
    expect(isPermanentFailure(failure)).toBe(false);
  });

  it.each([301, 302, 303, 307, 308])('stops at a %i redirect and sends nothing to its target', async (status) => {
    const target = await startStub(replying('facts'));
    const redirecting = await startStub(() => ({
      status,
      body: '',
      headers: { location: `${target.baseUrl.origin}/v1/chat/completions?token=${ZEBRA}` },
    }));
    const reply = await ask(redirecting, 'k-endpoint');
    expect(target.requests).toHaveLength(0);
    expect(reply).toEqual({
      ok: false,
      failure: {
        kind: 'http',
        status,
        detail: `the endpoint answered a redirect (${status}); hippo does not follow redirects`,
      },
    });
    expect(redirecting.requests).toHaveLength(1);
    expect(replyText(reply)).not.toContain(ZEBRA);
  });

  it('names no redirect for a 304', async () => {
    const stub = await startStub(() => ({ status: 304, body: '' }));
    expect(failureOf(await ask(stub))).toEqual({ kind: 'http', status: 304, detail: '' });
  });

  it('gives a request failure when the connection is refused', async () => {
    const stub = await startStub(replying('facts'));
    const [server] = stubs;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(failureOf(await ask(stub)).kind).toBe('request');
  });
});

describe('no reply text reaches a failure, a message or a log line', () => {
  const scenarios = [
    {
      name: 'a 500 that echoes the prompt',
      reply: (req: Recorded) => ({ status: 500, body: `ECHO ${ZEBRA} ${req.body}` }),
      message: 'HTTP 500',
      classLine: false,
    },
    {
      name: 'a 200 whose body is not JSON',
      reply: () => ({ status: 200, body: `${ZEBRA} not json` }),
      message: 'unparseable response: reply is not JSON',
      classLine: false,
    },
    {
      name: 'a 200 whose content is not JSON',
      reply: replying(`${ZEBRA} not json`),
      message: 'unparseable response: the reply is not a JSON array',
      classLine: true,
    },
  ];

  it.each(scenarios.flatMap((s) => [true, false].map((withOnError) => ({ ...s, withOnError }))))(
    '$name, with onError: $withOnError',
    async ({ reply, message, classLine, withOnError }) => {
      const stub = await startStub(reply);
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const messages: string[] = [];
      const failures: LlmFailure[] = [];
      const llm = openAiChatLlm({ baseUrl: stub.baseUrl, model: 'local-model' });
      const onError = (msg: string, failure?: LlmFailure): void => {
        messages.push(msg);
        if (failure) failures.push(failure);
      };

      await extractFacts('Alice likes tea', withOnError ? { llm, onError } : { llm });

      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(messages.join('\n')).not.toContain(ZEBRA);
      expect(failures.map(failureText).join('\n')).not.toContain(ZEBRA);
      expect(written).not.toContain(ZEBRA);
      if (withOnError) expect(messages).toEqual([message]);
      else expect(written).toContain(`fact extraction failed: ${message}`);
      if (!withOnError && classLine) expect(written).toContain('errorClass=SyntaxError');
    },
  );
});

describe('openAiChatLlm key rule', () => {
  it('refuses a key a header cannot carry, with no request and no echo', async () => {
    const stub = await startStub(replying('facts'));
    const reply = await ask(stub, `${ZEBRA}\nb`);
    expect(reply).toEqual({
      ok: false,
      failure: { kind: 'config', message: 'HIPPO_LLM_API_KEY has characters a header cannot carry' },
    });
    expect(replyText(reply)).not.toContain(ZEBRA);
    expect(stub.requests).toEqual([]);
  });
});
