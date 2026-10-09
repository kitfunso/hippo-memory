/** The one Anthropic Messages client: sends one user prompt and returns the reply text or a typed failure the caller reacts to. */

import { fetchWithRetry, llmTimeoutMs } from './http-retry.js';
import { errorMessage } from './log.js';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

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
    const data: { content?: Array<{ text?: string }> } = await res.json();
    return { ok: true, text: data.content?.[0]?.text?.trim() ?? '' };
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
