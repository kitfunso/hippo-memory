// The OpenAI-compatible chat adapter behind the Llm port, for a model the customer runs: one user
// prompt in, the reply text or a typed failure out.

import type { Llm, LlmReply, LlmRequest, LlmUsage } from '../base/ports/llm.js';
import { envLlmTimeoutMs } from '../base/util/env.js';

import { fetchWithRetry, isRetryableStatus, llmTimeoutMs, llmTotalMs } from './http-retry.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { readCappedJson } from '../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../base/util/limits.js';
import { type JsonValue, isJsonObject, isJsonString } from '../base/util/json.js';

export interface ChatEndpoint {
  readonly baseUrl: URL;
  readonly model: string;
  readonly apiKey?: string;
  /** Injected for tests; defaults to the real fetch. */
  readonly fetcher?: typeof fetch;
}

/** An Llm that posts chat completions to `endpoint`, always naming the endpoint's own model. */
export function openAiChatLlm(endpoint: ChatEndpoint): Llm {
  return { send: (request) => sendChat(endpoint, request) };
}

/** The reply's first choice text; undefined when the reply holds no string there. */
function contentOf(reply: { [key: string]: JsonValue }): string | undefined {
  const choice = Array.isArray(reply.choices) ? reply.choices[0] : undefined;
  const message = isJsonObject(choice) ? choice.message : undefined;
  const content = isJsonObject(message) ? message.content : undefined;
  return isJsonString(content) ? content : undefined;
}

/** The reply's billed tokens, or undefined when its usage block is missing or malformed. */
function usageOf(reply: { [key: string]: JsonValue }): LlmUsage | undefined {
  const usage = reply.usage;
  if (!isJsonObject(usage)) return undefined;
  const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = usage;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) return undefined;
  return { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) };
}

// A failed reply's body is never read: a server that echoes the prompt would put memory text in a log.
function failureDetail(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return 'the endpoint refused the key (HIPPO_LLM_API_KEY)';
    case 402:
      return 'the endpoint asked for payment';
    case 404:
      return 'no such path or model at the endpoint (HIPPO_LLM_BASE_URL, HIPPO_LLM_MODEL)';
    default:
      return '';
  }
}

function chatHeaders(apiKey: string | undefined): Headers {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
  return headers;
}

/** The reply's first choice text, trimmed; a reply with no text is a failure of kind 'empty'.
 * Never throws. */
async function readReply(res: Response): Promise<LlmReply> {
  try {
    const data = await readCappedJson(res, MAX_REPLY_BYTES);
    if (!isJsonObject(data)) {
      return {
        ok: false,
        failure: { kind: 'unreadable', message: 'the reply is not a JSON object' },
      };
    }
    const content = contentOf(data);
    if (content === undefined) {
      return {
        ok: false,
        failure: {
          kind: 'unreadable',
          message: 'the reply held no choices[0].message.content string',
        },
      };
    }
    const text = content.trim();
    const usage = usageOf(data);
    const reply: LlmReply =
      text === '' ? { ok: false, failure: { kind: 'empty' } } : { ok: true, text };
    return usage === undefined ? reply : { ...reply, usage };
  } catch (err) {
    // The parse error under this message quotes the reply.
    return { ok: false, failure: { kind: 'unreadable', message: errorMessage(err) } };
  }
}

/** The reply text or a typed failure for one prompt. Never throws. */
async function sendChat(endpoint: ChatEndpoint, req: LlmRequest): Promise<LlmReply> {
  let headers: Headers;
  // fetch's header error quotes the value, so the key; only a fixed text leaves.
  try {
    headers = chatHeaders(endpoint.apiKey);
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: 'HIPPO_LLM_API_KEY has characters a header cannot carry',
      },
    };
  }
  let res: Response;
  try {
    res = await postChat(endpoint, headers, req, llmTimeoutMs(envLlmTimeoutMs()));
  } catch (err) {
    return { ok: false, failure: { kind: 'request', message: errorMessage(err), cause: err } };
  }
  if (res.ok) return readReply(res);
  try {
    await res.body?.cancel();
  } catch (err) {
    log.debug('openai-chat: error body cancel failed', errorFields(err));
  }
  return {
    ok: false,
    failure: { kind: 'http', status: res.status, detail: failureDetail(res.status) },
  };
}

function postChat(
  endpoint: ChatEndpoint,
  headers: Headers,
  req: LlmRequest,
  timeoutMs: number,
): Promise<Response> {
  const { baseUrl } = endpoint;
  return fetchWithRetry(
    `${baseUrl.origin}${baseUrl.pathname.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: endpoint.model,
        max_tokens: req.maxTokens,
        messages: [{ role: 'user', content: req.prompt }],
      }),
      signal: req.signal,
    },
    // A chat call stores nothing on the far side, so a 429 or a 5xx is replayed.
    {
      timeoutMs,
      totalMs: llmTotalMs(timeoutMs),
      retryTransport: true,
      retryOn: (r) => isRetryableStatus(r.status),
      fetchFn: endpoint.fetcher ?? fetch,
    },
  );
}
