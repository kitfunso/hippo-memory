import { MINUTE_MS } from '../base/util/time.js';
import { errorCode, errorFields, log } from '../base/util/log.js';
import { tryParseUrl } from '../base/util/net.js';

export interface RetryPolicy {
  timeoutMs: number;
  attempts?: number;
  totalMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (res: Response) => boolean;
  retryTransport?: boolean;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8_000;
const DEFAULT_LLM_TIMEOUT_MS = MINUTE_MS;

/** LLM calls (consolidation refine, DAG summaries, fact extraction) share one budget; both LLM
 * clients pass `HIPPO_LLM_TIMEOUT_MS` as `configured`. */
export function llmTimeoutMs(configured?: number): number {
  return configured ?? DEFAULT_LLM_TIMEOUT_MS;
}

/** One LLM call with its retries: two full attempts and the longest wait between them, where
 * three slow failures would hold a sleep for 3x the timeout. */
export function llmTotalMs(timeoutMs: number = llmTimeoutMs()): number {
  return 2 * timeoutMs + DEFAULT_MAX_DELAY_MS;
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
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** A dropped connection, a DNS hiccup or a timed-out attempt: faults a second try can clear. A
 * refused connection is not one. */
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

function redactedTarget(url: string | URL): string {
  const u = url instanceof URL ? url : tryParseUrl(url);
  return u === undefined ? 'unparseable-url' : `${u.host}${u.pathname}`;
}

interface RetryLogEntry {
  init: RequestInit;
  url: string | URL;
  reason: string;
  attempt: number;
  attempts: number;
  delayMs: number;
}

function logRetry(entry: RetryLogEntry): void {
  const { init, url, reason, attempt, attempts, delayMs } = entry;
  log.debug('http retry', {
    method: (init.method ?? 'GET').toUpperCase(),
    target: redactedTarget(url),
    reason,
    attempt: `${attempt}/${attempts}`,
    delayMs: Math.round(delayMs),
  });
}

type Sleep = (ms: number) => Promise<void>;

const timerSleep = (ms: number, cancel?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    cancel?.addEventListener('abort', () => clearTimeout(timer), { once: true });
  });

async function backoffWait(
  ms: number,
  sleep: Sleep | undefined,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!signal) return (sleep ?? timerSleep)(ms);
  signal.throwIfAborted();
  const left = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
      signal: left.signal,
    });
  });
  try {
    await Promise.race([sleep ? sleep(ms) : timerSleep(ms, left.signal), aborted]);
  } finally {
    left.abort();
  }
}

const defaultRetryOn =
  (replaySafe: boolean) =>
  (res: Response): boolean =>
    res.status === 429 || (replaySafe && isRetryableStatus(res.status));

interface RetryRun {
  readonly url: string | URL;
  readonly init: RequestInit;
  readonly fetchFn: typeof fetch;
  readonly attempts: number;
  readonly maxDelayMs: number;
  readonly replaySafe: boolean;
  readonly retryOn: (res: Response) => boolean;
  readonly now: () => number;
  readonly deadline: number;
  readonly fitsBudget: (delayMs: number) => boolean;
  readonly backoffMs: (attempt: number) => number;
}

/** `fetch` with a per-attempt timeout and up to `attempts` tries on 429 and, for a replay-safe
 * call (see `retryTransport`), on 5xx and transport faults; the last response or error comes
 * back as is. */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  policy: RetryPolicy,
): Promise<Response> {
  const run = retryRun(url, init, policy);
  const { fetchFn, deadline, now } = run;
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(policy.timeoutMs, deadline - now())));
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetchFn(url, { ...init, signal });
    } catch (err) {
      await backoffWait(faultDelay(run, attempt, err), policy.sleep, init.signal);
      continue;
    }
    const delay = responseDelay(run, attempt, res);
    if (delay === null) return res;
    // Frees the pooled socket before the next attempt.
    try {
      await res.body?.cancel();
    } catch (err) {
      log.debug('http retry: body cancel failed', errorFields(err));
    }
    const reason = `status ${res.status}`;
    logRetry({ init, url, reason, attempt, attempts: run.attempts, delayMs: delay });
    await backoffWait(delay, policy.sleep, init.signal);
  }
}

function retryRun(url: string | URL, init: RequestInit, policy: RetryPolicy): RetryRun {
  const fetchFn = policy.fetchFn ?? fetch;
  const attempts = Math.max(1, policy.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = policy.random ?? Math.random;
  const replaySafe = policy.retryTransport ?? isIdempotent(init.method);
  const retryOn = policy.retryOn ?? defaultRetryOn(replaySafe);
  const now = policy.now ?? Date.now;
  const deadline = policy.totalMs === undefined ? Infinity : now() + policy.totalMs;
  const fitsBudget = (delayMs: number): boolean => now() + delayMs < deadline;
  const backoffMs = (attempt: number): number => {
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return ceiling / 2 + random() * (ceiling / 2);
  };
  return {
    url,
    init,
    fetchFn,
    attempts,
    maxDelayMs,
    replaySafe,
    retryOn,
    now,
    deadline,
    fitsBudget,
    backoffMs,
  };
}

function faultDelay<E>(run: RetryRun, attempt: number, err: E): number {
  const { init, url, attempts } = run;
  if (
    !run.replaySafe ||
    attempt >= attempts ||
    init.signal?.aborted ||
    !isTransientTransportError(err)
  ) {
    throw err;
  }
  const delay = run.backoffMs(attempt);
  if (!run.fitsBudget(delay)) throw err;
  const reason = errorCode(err) || (err instanceof Error ? err.name : 'transport');
  logRetry({ init, url, reason, attempt, attempts, delayMs: delay });
  return delay;
}

function responseDelay(run: RetryRun, attempt: number, res: Response): number | null {
  const { retryOn } = run;
  if (!retryOn(res) || attempt >= run.attempts) return null;
  const retryAfter = parseRetryAfterMs(res.headers.get('retry-after'));
  if (retryAfter !== null && retryAfter > run.maxDelayMs) return null;
  const delay = retryAfter ?? run.backoffMs(attempt);
  return run.fitsBudget(delay) ? delay : null;
}
