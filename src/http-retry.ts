/** One retry policy for outbound HTTP: a timeout on every attempt, and backoff on 429 and 5xx only. */

import { envLlmTimeoutMs } from './env.js';

export interface RetryPolicy {
  /** Per-attempt limit; a stalled peer ends as a thrown `TimeoutError`, never a hang. */
  timeoutMs: number;
  /** Total attempts including the first. */
  attempts?: number;
  baseDelayMs?: number;
  /** A Retry-After longer than this hands the response back, so a caller with its own long pause keeps it. */
  maxDelayMs?: number;
  /** Which responses to retry; defaults to 429 and 5xx. A write narrows it to answers that prove nothing committed. */
  retryOn?: (res: Response) => boolean;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_LLM_TIMEOUT_MS = 60_000;

/** LLM calls (consolidation refine, DAG summaries, fact extraction) share one budget; `HIPPO_LLM_TIMEOUT_MS` overrides it. */
export function llmTimeoutMs(): number {
  return envLlmTimeoutMs() ?? DEFAULT_LLM_TIMEOUT_MS;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `fetch` with a per-attempt timeout and up to `attempts` tries on 429 and 5xx; the last response comes back as is and transport errors throw at once. */
export async function fetchWithRetry(url: string | URL, init: RequestInit, policy: RetryPolicy): Promise<Response> {
  const fetchFn = policy.fetchFn ?? fetch;
  const attempts = Math.max(1, policy.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = policy.sleep ?? realSleep;
  const random = policy.random ?? Math.random;
  const retryOn = policy.retryOn ?? ((res: Response) => isRetryableStatus(res.status));

  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const res = await fetchFn(url, { ...init, signal });
    if (!retryOn(res) || attempt >= attempts) return res;

    const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
    if (retryAfter !== null && retryAfter > maxDelayMs) return res;
    // Jitter over the upper half keeps parallel callers from retrying in lockstep.
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    const delay = retryAfter ?? ceiling / 2 + random() * (ceiling / 2);
    // Frees the pooled socket before the next attempt.
    await res.body?.cancel();
    await sleep(delay);
  }
}
