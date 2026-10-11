/** The one Anthropic Messages client: sends one user prompt and returns the reply text or a typed failure the caller reacts to. */

import { fetchWithRetry, llmTimeoutMs, llmTotalMs } from './http-retry.js';
import { errorMessage } from './log.js';
import { readCappedJson, readCappedText } from './capped-json.js';
import { type JsonValue, isJsonObject, isJsonString } from './json.js';
import { redactSecretsStrict } from './secret-detect.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
// Callers ask for at most 1,200 tokens, a reply of a few KB; 1 MiB leaves room for a verbose envelope.
const MAX_REPLY_BYTES = 1024 * 1024;
// The error body names the cause (bad key, no credit, unknown model) in its first line or two.
const ERROR_SNIPPET_CHARS = 256;
const UTF8_MAX_BYTES_PER_CHAR = 4;
// A bad or missing key, no credit, no permission, an unknown model: every later call gets the same answer.
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404]);

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
  | { kind: 'http'; status: number; detail: string }
  | { kind: 'unreadable'; message: string };

export type AnthropicMessageResult =
  | { ok: true; text: string }
  | { ok: false; failure: AnthropicMessageFailure };

/** True for a failure the next call would repeat, so a caller looping over items should stop rather than retry. */
export function isPermanentFailure(failure: AnthropicMessageFailure): boolean {
  return failure.kind === 'http' && PERMANENT_STATUSES.has(failure.status);
}

/** The start of a failed reply's body, on one line with any key-shaped text masked; empty when the body cannot be read. */
async function errorSnippet(res: Response): Promise<string> {
  // The status is the failure reported; a body that cannot be read only costs its snippet.
  const body = await readCappedText(res, ERROR_SNIPPET_CHARS * UTF8_MAX_BYTES_PER_CHAR).catch(() => '');
  // Masked before the cut, so a key that straddles the cut is never left half shown.
  return redactSecretsStrict(body.replace(/\s+/g, ' ').trim()).slice(0, ERROR_SNIPPET_CHARS);
}

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
    }, { timeoutMs: llmTimeoutMs(), totalMs: llmTotalMs(), fetchFn: req.fetcher ?? fetch });
  } catch (err) {
    return { ok: false, failure: { kind: 'request', message: errorMessage(err) } };
  }
  if (!res.ok) return { ok: false, failure: { kind: 'http', status: res.status, detail: await errorSnippet(res) } };

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
    case 'http': return failure.detail ? `HTTP ${failure.status}: ${failure.detail}` : `HTTP ${failure.status}`;
    case 'unreadable': return `unparseable response: ${failure.message}`;
  }
}
