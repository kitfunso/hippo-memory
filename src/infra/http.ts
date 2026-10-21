// The adapter behind the Http port: fetch, under the retry policy every outbound call of hippo's shares.
import type { Http } from '../base/ports/http.js';
import { fetchWithRetry } from './http-retry.js';

/** Http over `fetcher`; with none, the global fetch as it stands at each call, so a test's spy on it is seen. */
export function httpOver(fetcher?: typeof fetch): Http {
  return { send: (url, init, policy) => fetchWithRetry(url, init, { ...policy, fetchFn: fetcher }) };
}

export const processHttp: Http = httpOver();
