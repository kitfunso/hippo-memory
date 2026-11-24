import type { Llm, LlmReply, LlmRequest, LlmUsage } from '../base/ports/llm.js';
import { envLlmTimeoutMs } from '../base/util/env.js';

import { fetchWithRetry, isRetryableStatus, llmTimeoutMs, llmTotalMs } from './http-retry.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { readCappedJson, readCappedText } from '../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../base/util/limits.js';
import { type JsonValue, isJsonObject, isJsonString } from '../base/util/json.js';
import { redactSecretsStrict } from '../base/util/secret-detect.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ERROR_SNIPPET_CHARS = 256;
const UTF8_MAX_BYTES_PER_CHAR = 4;

function firstText(reply: { [key: string]: JsonValue }): string {
  const blocks = Array.isArray(reply.content) ? reply.content : [];
  const first = blocks.find((block) => isJsonObject(block) && isJsonString(block.text));
  const text = isJsonObject(first) ? first.text : undefined;
  return isJsonString(text) ? text.trim() : '';
}

function usageOf(reply: { [key: string]: JsonValue }): LlmUsage | undefined {
  const usage = reply.usage;
  if (!isJsonObject(usage)) return undefined;
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage;
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) return undefined;
  return { inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) };
}

export interface AnthropicConnection {
  readonly apiKey: string;
  readonly fetcher?: typeof fetch;
}

/** An Llm that calls the Anthropic Messages API with `apiKey`. */
export function anthropicLlm(connection: AnthropicConnection): Llm {
  return { send: (request) => sendMessage(connection, request) };
}

async function errorSnippet(res: Response): Promise<string> {
  const body = await readCappedText(res, ERROR_SNIPPET_CHARS * UTF8_MAX_BYTES_PER_CHAR).catch(
    (err: Error) => {
      log.warn(
        `anthropic: could not read the error body of a ${res.status} reply`,
        errorFields(err),
      );
      return '';
    },
  );
  return redactSecretsStrict(body.replace(/\s+/g, ' ').trim()).slice(0, ERROR_SNIPPET_CHARS);
}

async function sendMessage(connection: AnthropicConnection, req: LlmRequest): Promise<LlmReply> {
  let headers: Headers;
  // fetch's header error quotes the value, so the key; only a fixed text leaves.
  try {
    headers = new Headers({
      'content-type': 'application/json',
      'x-api-key': connection.apiKey,
      'anthropic-version': API_VERSION,
    });
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'config',
        message: 'ANTHROPIC_API_KEY has characters a header cannot carry',
      },
    };
  }
  const timeoutMs = llmTimeoutMs(envLlmTimeoutMs());
  let res: Response;
  try {
    res = await postMessage(connection, headers, req, timeoutMs);
  } catch (err) {
    return { ok: false, failure: { kind: 'request', message: errorMessage(err), cause: err } };
  }
  if (!res.ok) {
    return {
      ok: false,
      failure: { kind: 'http', status: res.status, detail: await errorSnippet(res) },
    };
  }

  try {
    const data = await readCappedJson(res, MAX_REPLY_BYTES);
    if (!isJsonObject(data)) {
      return {
        ok: false,
        failure: { kind: 'unreadable', message: 'the reply is not a JSON object' },
      };
    }
    const text = firstText(data);
    const usage = usageOf(data);
    const reply: LlmReply =
      text === '' ? { ok: false, failure: { kind: 'empty' } } : { ok: true, text };
    return usage === undefined ? reply : { ...reply, usage };
  } catch (err) {
    return { ok: false, failure: { kind: 'unreadable', message: errorMessage(err) } };
  }
}

function postMessage(
  connection: AnthropicConnection,
  headers: Headers,
  req: LlmRequest,
  timeoutMs: number,
): Promise<Response> {
  return fetchWithRetry(
    MESSAGES_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: req.model ?? DEFAULT_MODEL,
        max_tokens: req.maxTokens,
        messages: [{ role: 'user', content: req.prompt }],
      }),
      signal: req.signal,
    },
    {
      timeoutMs,
      totalMs: llmTotalMs(timeoutMs),
      retryTransport: true,
      retryOn: (r) => isRetryableStatus(r.status),
      fetchFn: connection.fetcher ?? fetch,
    },
  );
}
