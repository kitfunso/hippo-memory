/**
 * Octokit-shaped HTTP fetcher for the GitHub connector backfill.
 *
 * Production uses `realGitHubFetcher` against `https://api.github.com`.
 * Tests inject a fake `GitHubFetcher` so they never hit the network.
 *
 * Codex P1 #4 mandate: any non-200 response that is NOT a recognized
 * rate-limit pause MUST throw `GitHubFetchError`. Silently turning
 * 401/403/404/500 into empty pages produced empty backfills with no
 * operator signal, so this code path is now load-bearing.
 */

import type { JsonValue } from './types.js';
import { parseRateLimit, type RateLimitInfo } from './ratelimit.js';

export class GitHubFetchError extends Error {
  constructor(
    readonly status: number,
    readonly bodyExcerpt: string,
    readonly url: string,
  ) {
    super(`GitHub ${status} on ${url}: ${bodyExcerpt}`);
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

/**
 * Parse the rel="next" URL from an RFC 5988 `Link` header.
 *
 * Header format: `<url1>; rel="next", <url2>; rel="last"`.
 * Returns the URL whose rel parameter is exactly `"next"`, or null.
 */
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

export const realGitHubFetcher: GitHubFetcher = async ({ url, token }) => {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const headers = headersToRecord(res.headers);
  const rateLimit = parseRateLimit(headers, res.status);

  // Codex P1 #4: don't silently turn 401/403/404/500 into empty pages.
  if (res.status !== 200 && rateLimit.reason === 'none') {
    const body = await res.text().catch(() => '');
    throw new GitHubFetchError(res.status, body.slice(0, 256), url);
  }

  // SAFETY: GitHub's list/paginated endpoints (issues, comments, etc. — the
  // only endpoints this backfill fetcher targets) return a JSON array body
  // on 200; per-item shape is intentionally left as `unknown` here since
  // GitHubBackfillPage.items is opaque to this seam (callers parse the
  // shape they expect downstream).
  const items =
    res.status === 200 ? ((await res.json()) as Array<JsonValue>) : [];
  const link = res.headers.get('link') ?? '';
  const next = parseNextLink(link);
  return { items, next, rateLimit };
};
