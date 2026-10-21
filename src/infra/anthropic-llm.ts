// The Anthropic Messages adapter behind the Llm port: one user prompt in, the reply text or a typed failure out.

import type { Llm, LlmReply, LlmRequest } from '../base/ports/llm.js';
import { envLlmTimeoutMs } from '../base/util/env.js';
import { fetchWithRetry, llmTimeoutMs, llmTotalMs } from './http-retry.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { readCappedJson, readCappedText } from '../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../base/util/limits.js';
import { type JsonValue, isJsonObject, isJsonString } from '../base/util/json.js';
import { redactSecretsStrict } from '../base/util/secret-detect.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
// The error body names the cause (bad key, no credit, unknown model) in its first line or two.
const ERROR_SNIPPET_CHARS = 256;
const UTF8_MAX_BYTES_PER_CHAR = 4;

/** The first content block's text, trimmed; empty when the reply has no such block. */
function firstText(reply: { [key: string]: JsonValue }): string {
  const first = Array.isArray(reply.content) ? reply.content[0] : undefined;
  const text = isJsonObject(first) ? first.text : undefined;
  return isJsonString(text) ? text.trim() : '';
}

export interface AnthropicConnection {
  readonly apiKey: string;
  /** Injected for tests; defaults to the real fetch. */
  readonly fetcher?: typeof fetch;
}

/** An Llm that calls the Anthropic Messages API with `apiKey`. */
export function anthropicLlm(connection: AnthropicConnection): Llm {
  return { send: (request) => sendMessage(connection, request) };
}

/**
 * The start of a failed reply's body, on one line with any key-shaped text masked; empty when the body cannot be read.
 */
async function errorSnippet(res: Response): Promise<string> {
  // The status is the failure reported; a body that cannot be read only costs its snippet.
  const body = await readCappedText(res, ERROR_SNIPPET_CHARS * UTF8_MAX_BYTES_PER_CHAR).catch((err: Error) => {
    log.warn(`anthropic: could not read the error body of a ${res.status} reply`, errorFields(err));
    return '';
  });
  // Masked before the cut, so a key that straddles the cut is never left half shown.
  return redactSecretsStrict(body.replace(/\s+/g, ' ').trim()).slice(0, ERROR_SNIPPET_CHARS);
}

/** The reply's first text block, trimmed; a reply with no text is a failure of kind 'empty'. Never throws. */
async function sendMessage(connection: AnthropicConnection, req: LlmRequest): Promise<LlmReply> {
  const timeoutMs = llmTimeoutMs(envLlmTimeoutMs());
  let res: Response;
  try {
    res = await fetchWithRetry(
      MESSAGES_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': connection.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: req.model ?? DEFAULT_MODEL,
          max_tokens: req.maxTokens,
          messages: [{ role: 'user', content: req.prompt }],
        }),
      },
      { timeoutMs, totalMs: llmTotalMs(timeoutMs), fetchFn: connection.fetcher ?? fetch },
    );
  } catch (err) {
    return { ok: false, failure: { kind: 'request', message: errorMessage(err), cause: err } };
  }
  if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status, detail: await errorSnippet(res) } };

  try {
    const data = await readCappedJson(res, MAX_REPLY_BYTES);
    if (!isJsonObject(data)) {
      return { ok: false, failure: { kind: 'unreadable', message: 'the reply is not a JSON object' } };
    }
    const text = firstText(data);
    return text === '' ? { ok: false, failure: { kind: 'empty' } } : { ok: true, text };
  } catch (err) {
    return { ok: false, failure: { kind: 'unreadable', message: errorMessage(err), cause: err } };
  }
}
