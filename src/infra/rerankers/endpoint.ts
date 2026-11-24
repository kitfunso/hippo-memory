import type { Http } from '../../base/ports/http.js';

export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.13.0';

const RETRY_WAIT_CAP_MS = 2_000;

/** One scoring call: where it goes, the bearer token when the far side wants one, its JSON body
 * and its budget. */
export interface ScoringRequest {
  readonly url: string;
  readonly token: string | undefined;
  readonly body: object;
  readonly budgetMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * POST a scoring request. A dropped connection, 429 or 5xx is retried, since scoring changes
 * nothing on the far side.
 */
export async function postScoring(http: Http, request: ScoringRequest): Promise<Response> {
  const { url, token, body, budgetMs, signal: requestSignal } = request;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  const budget = AbortSignal.timeout(budgetMs);
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
