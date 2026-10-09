// The one bounded, retried POST every remote reranker sends.
import { fetchWithRetry } from '../http-retry.js';

// A Retry-After longer than this would outlast most budgets, so the answer is handed back and the reranker falls back.
const RETRY_WAIT_CAP_MS = 2_000;

/** POST a scoring request. A dropped connection, 429 or 5xx is retried, since scoring changes nothing on the far side. */
export async function rerankerPost(url: string, init: RequestInit, budgetMs: number): Promise<Response> {
  // The budget bounds the whole call, retries included, so recall never waits past the configured timeout.
  const budget = AbortSignal.timeout(budgetMs);
  try {
    return await fetchWithRetry(url, { ...init, method: 'POST', signal: budget }, {
      timeoutMs: budgetMs,
      retryTransport: true,
      maxDelayMs: RETRY_WAIT_CAP_MS,
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`no answer within ${budgetMs} ms`, { cause: err });
    }
    throw err;
  }
}
