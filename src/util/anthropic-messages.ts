/** The one Anthropic Messages client: sends one user prompt and returns the reply text or a typed failure the caller reacts to. */

import { fetchWithRetry, llmTimeoutMs } from './http-retry.js';
import { errorMessage } from './log.js';
import { readCappedJson } from './capped-json.js';
import { type JsonValue, isJsonObject, isJsonString } from './json.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Callers ask for at most 1,200 tokens, a reply of a few KB; 1 MiB leaves room for a verbose envelope.
const MAX_REPLY_BYTES = 1024 * 1024;

/** The first content block's text, trimmed; empty when the reply has no such block. */
function firstText(reply: { [key: string]: JsonValue }): string {
  const first = Array.isArray(reply.content) ? reply.content[0] : undefined;
  const text = isJsonObject(first) ? first.text : undefined;
  return isJsonString(text) ? text.trim() : '';
}

export interface AnthropicMessageRequest {
  apiKey: string;
  model?: string;
  maxTokens: number;
  prompt: string;
  /** Injected for tests; defaults to the real fetch. */
  fetcher?: typeof fetch;
}

export type AnthropicMessageFailure =
  | { kind: 'request'; message: string }
  | { kind: 'http'; status: number }
  | { kind: 'unreadable'; message: string };

export type AnthropicMessageResult =
  | { ok: true; text: string }
  | { ok: false; failure: AnthropicMessageFailure };

/** The reply's first text block, trimmed (empty when the reply has none); never throws. */
export async function sendAnthropicMessage(req: AnthropicMessageRequest): Promise<AnthropicMessageResult> {
  let res: Response;
  try {
    res = await fetchWithRetry(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: req.model ?? DEFAULT_MODEL,
        max_tokens: req.maxTokens,
        messages: [{ role: 'user', content: req.prompt }],
      }),
    }, { timeoutMs: llmTimeoutMs(), fetchFn: req.fetcher ?? fetch });
  } catch (err) {
    return { ok: false, failure: { kind: 'request', message: errorMessage(err) } };
  }
  if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status } };

  try {
    const data = await readCappedJson(res, MAX_REPLY_BYTES);
    if (!isJsonObject(data)) return { ok: false, failure: { kind: 'unreadable', message: 'the reply is not a JSON object' } };
    return { ok: true, text: firstText(data) };
  } catch (err) {
    return { ok: false, failure: { kind: 'unreadable', message: errorMessage(err) } };
  }
}

/** The text extraction and DAG summaries hand to their `onError` callback. */
export function describeMessageFailure(failure: AnthropicMessageFailure): string {
  switch (failure.kind) {
    case 'request': return `request failed: ${failure.message}`;
    case 'http': return `HTTP ${failure.status}`;
    case 'unreadable': return `unparseable response: ${failure.message}`;
  }
}
