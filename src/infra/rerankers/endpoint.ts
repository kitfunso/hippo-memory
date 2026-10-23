// The one outbound rule every hosted scorer follows: TypeSafe's address and pinned model, and one bounded, retried JSON
// POST through the Http port its root hands the scorer.
import type { Http } from '../../base/ports/http.js';
import { currentSignal } from '../../base/util/request-scope.js';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Pinned, not `jev-latest`: the eval numbers were measured on this version, and the alias moves whenever the vendor
// ships a release.
export const JEV_MODEL = 'jev-1.13.0';

// A Retry-After longer than this would outlast most budgets, so the answer is handed back and the scorer falls back.
const RETRY_WAIT_CAP_MS = 2_000;

/** One scoring call: where it goes, the bearer token when the far side wants one, its JSON body and its budget. */
export interface ScoringRequest {
  readonly url: string;
  readonly token: string | undefined;
  readonly body: object;
  /** Bounds the whole call, retries included, so a recall or a capture never waits past it. */
  readonly budgetMs: number;
}

/**
 * POST a scoring request. A dropped connection, 429 or 5xx is retried, since scoring changes nothing on the far side.
 */
export async function postScoring(http: Http, { url, token, body, budgetMs }: ScoringRequest): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  const budget = AbortSignal.timeout(budgetMs);
  // The request's own abort ends the post too, so a client that hung up does not leave retries running.
  const requestSignal = currentSignal();
  const signal = requestSignal === undefined ? budget : AbortSignal.any([requestSignal, budget]);
  try {
    return await http.send(
      url,
      { method: 'POST', headers, body: JSON.stringify(body), signal },
      { timeoutMs: budgetMs, retryTransport: true, maxDelayMs: RETRY_WAIT_CAP_MS },
    );
  } catch (err) {
    if (requestSignal?.aborted) throw err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`no answer within ${budgetMs} ms`, { cause: err });
    }
    throw err;
  }
}
