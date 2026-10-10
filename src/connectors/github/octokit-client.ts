/** Octokit-shaped HTTP fetcher for the GitHub backfill; tests inject a fake `GitHubFetcher`.
 *  Any non-200 that is not a recognised rate-limit pause MUST throw `GitHubFetchError`, since an empty page would be a silent empty backfill. */

import { parseRateLimit, type RateLimitInfo } from './ratelimit.js';
import { fetchWithRetry } from '../../util/http-retry.js';
import type { JsonValue } from '../../util/json.js';
import { readCappedJson, readCappedText } from '../../util/capped-json.js';
import { errorMessage } from '../../util/log.js';

export class GitHubFetchError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    readonly url: string,
    options?: ErrorOptions,
  ) {
    super(`GitHub ${status} on ${url}: ${bodyExcerpt}`, options);
    this.name = 'GitHubFetchError';
  }
}

export interface GitHubBackfillPage {
  readonly items: ReadonlyArray<JsonValue>;
  readonly next: string | null;
  readonly rateLimit: RateLimitInfo;
}

export type GitHubFetcher = (args: {
  url: string;
  token: string;
}) => Promise<GitHubBackfillPage>;

/** Parse the rel="next" URL from an RFC 5988 `Link` header, or null. */
export function parseNextLink(linkHeader: string): string | null {
  if (!linkHeader) return null;
  const re = /<([^>]+)>\s*;\s*rel="next"/;
  const m = linkHeader.match(re);
  return m ? m[1] : null;
}

function headersToRecord(h: Headers): Record<string, string | undefined> {
  const entries: Array<[string, string]> = [];
  h.forEach((v, k) => {
    entries.push([k.toLowerCase(), v]);
  });
  return Object.fromEntries(entries);
}

const GITHUB_TIMEOUT_MS = 30_000;
const ERROR_BODY_SNIPPET_CHARS = 256;
const UTF8_MAX_BYTES_PER_CHAR = 4;
// A page is at most 100 items (per_page=100), each with a body of up to 65,536 characters at 4 bytes, plus its fields.
const GITHUB_MAX_REPLY_BYTES = 32 * 1024 * 1024;

/** The items of a 200 list reply. A body that is not JSON, is over the cap or is not an array throws, so it never reaches ingest as items. */
async function readItems(res: Response, url: string): Promise<JsonValue[]> {
  // The path only: a `next` link comes from the server, so its query string is not ours to print.
  const path = new URL(url).pathname;
  let body: JsonValue;
  try {
    body = await readCappedJson(res, GITHUB_MAX_REPLY_BYTES);
  } catch (err) {
    throw new GitHubFetchError(res.status, errorMessage(err), path, { cause: err });
  }
  if (!Array.isArray(body)) throw new GitHubFetchError(res.status, 'the reply is not a JSON array', path);
  return body;
}

export const realGitHubFetcher: GitHubFetcher = async ({ url, token }) => {
  const res = await fetchWithRetry(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, { timeoutMs: GITHUB_TIMEOUT_MS });
  const headers = headersToRecord(res.headers);
  const rateLimit = parseRateLimit(headers, res.status);

  // Don't silently turn 401/403/404/500 into empty pages.
  if (res.status !== 200 && rateLimit.reason === 'none') {
    // The status is the error reported; a body that cannot be read only costs its snippet.
    const body = await readCappedText(res, ERROR_BODY_SNIPPET_CHARS * UTF8_MAX_BYTES_PER_CHAR).catch(() => '');
    throw new GitHubFetchError(res.status, body.slice(0, ERROR_BODY_SNIPPET_CHARS), new URL(url).pathname);
  }

  const items = res.status === 200 ? await readItems(res, url) : [];
  const link = res.headers.get('link') ?? '';
  const next = parseNextLink(link);
  return { items, next, rateLimit };
};
