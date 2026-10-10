/** One retry policy for outbound HTTP: a timeout on every attempt, backoff on 429 and 5xx, and on a dropped connection where a replay is safe. */

import { envLlmTimeoutMs } from './env.js';
import { errorCode, log } from './log.js';

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
  /** Also retry a dropped connection or a timed-out attempt. On for GET and HEAD; any other method turns it on only when a replay cannot commit twice. */
  retryTransport?: boolean;
  fetchFn?: typeof fetch;
  /** Replaces the timer between attempts. A caller `signal` that aborts still ends the wait at once. */
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

// Node's fetch reports a broken socket as a bare `fetch failed` with one of these on its cause.
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
]);

/** A dropped connection, a DNS hiccup or a timed-out attempt: faults a second try can clear. A refused connection is not one. */
export function isTransientTransportError<E>(err: E): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError') return true;
  const holder = err.cause instanceof Object ? err.cause : err;
  const code = 'code' in holder ? String(holder.code) : '';
  return TRANSIENT_CODES.has(code) || err.message.toLowerCase().includes('socket hang up');
}

function isIdempotent(method: string | undefined): boolean {
  const verb = (method ?? 'GET').toUpperCase();
  return verb === 'GET' || verb === 'HEAD';
}

/** Host plus pathname only: a query string can carry a key. */
function redactedTarget(url: string | URL): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'unparseable-url';
  }
}

function warnRetry(init: RequestInit, url: string | URL, reason: string, attempt: number, attempts: number, delayMs: number): void {
  log.warn('http retry', {
    method: (init.method ?? 'GET').toUpperCase(), target: redactedTarget(url), reason, attempt: `${attempt}/${attempts}`, delayMs: Math.round(delayMs),
  });
}

type Sleep = (ms: number) => Promise<void>;

// `cancel` clears the timer, so a wait the caller left does not keep the process alive.
const timerSleep = (ms: number, cancel?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  cancel?.addEventListener('abort', () => clearTimeout(timer), { once: true });
});

/** The wait between attempts. With a caller signal it ends the moment that signal aborts and rejects with its reason, so no further attempt starts. */
async function backoffWait(ms: number, sleep: Sleep | undefined, signal: AbortSignal | null | undefined): Promise<void> {
  if (!signal) return (sleep ?? timerSleep)(ms);
  signal.throwIfAborted();
  const left = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true, signal: left.signal });
  });
  try {
    // An injected sleep cannot be cancelled, so it is raced and left to run out.
    await Promise.race([sleep ? sleep(ms) : timerSleep(ms, left.signal), aborted]);
  } finally {
    left.abort();
  }
}

/** `fetch` with a per-attempt timeout and up to `attempts` tries on 429, 5xx and (see
 * `retryTransport`) transport faults; the last response or error comes back as is. */
export async function fetchWithRetry(url: string | URL, init: RequestInit, policy: RetryPolicy): Promise<Response> {
  const fetchFn = policy.fetchFn ?? fetch;
  const attempts = Math.max(1, policy.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = policy.random ?? Math.random;
  const retryOn = policy.retryOn ?? ((res: Response) => isRetryableStatus(res.status));
  const retryTransport = policy.retryTransport ?? isIdempotent(init.method);
  // Jitter over the upper half keeps parallel callers from retrying in lockstep.
  const backoffMs = (attempt: number): number => {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return ceiling / 2 + random() * (ceiling / 2);
  };

  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal });
    } catch (err) {
      // The caller's own abort is a decision, not a fault, so it ends the call.
      if (!retryTransport || attempt >= attempts || init.signal?.aborted || !isTransientTransportError(err)) throw err;
      const delay = backoffMs(attempt);
      warnRetry(init, url, errorCode(err) || (err instanceof Error ? err.name : 'transport'), attempt, attempts, delay);
      await backoffWait(delay, policy.sleep, init.signal);
      continue;
    }
    if (!retryOn(res) || attempt >= attempts) return res;

    const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
    if (retryAfter !== null && retryAfter > maxDelayMs) return res;
    // Frees the pooled socket before the next attempt.
    await res.body?.cancel();
    const delay = retryAfter ?? backoffMs(attempt);
    warnRetry(init, url, `status ${res.status}`, attempt, attempts, delay);
    await backoffWait(delay, policy.sleep, init.signal);
  }
}
