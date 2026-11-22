/** Octokit-shaped HTTP fetcher for the GitHub backfill; tests inject a fake `GitHubFetcher`. Any
 * non-200 that is not a recognised rate-limit pause MUST throw `GitHubFetchError`, since an empty
 * page would be a silent empty backfill.
 */

import { parseRateLimit, type RateLimitInfo } from './ratelimit.js';
import { fetchWithRetry } from '../../../infra/http-retry.js';
import type { JsonValue } from '../../../base/util/json.js';
import { readCappedJson, readCappedText } from '../../../base/util/capped-json.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { tryParseUrl } from '../../../base/util/net.js';
import { safeCause } from '../../../base/util/safe-cause.js';

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

export type GitHubFetcher = (args: { url: string; token: string }) => Promise<GitHubBackfillPage>;

/** Asked before every request, so a token that expires mid-run is replaced in time. */
export type GitHubTokenSource = () => Promise<string>;

type Scrub = (text: string) => string;

export function staticTokenSource(token: string): GitHubTokenSource {
  return () => Promise.resolve(token);
}

// With only these characters an escaped echo of a token equals the token, so a window finds it.
const GITHUB_TOKEN_TEXT = /^[A-Za-z0-9_.-]+$/;

/** True when the token uses only characters GitHub tokens use; the caller words its own refusal. */
export function isGitHubTokenText(token: string): boolean {
  return GITHUB_TOKEN_TEXT.test(token);
}

// A fragment under this many characters may pass: the promise is that no window of this size survives.
const TOKEN_WINDOW_CHARS = 8;
const TOKEN_MARK = '[token]';

/** `text` with every run that an 8-character window of the token covers replaced by `[token]`, so
 * a whole copy, a cut copy and a partial echo all go, whatever the reply did to the token. */
export function redactTokenWindows(text: string, token: string): string {
  const windows = new Set<string>();
  for (let i = 0; i + TOKEN_WINDOW_CHARS <= token.length; i++) {
    windows.add(token.slice(i, i + TOKEN_WINDOW_CHARS));
  }
  if (windows.size === 0) return text;
  const covered = new Uint8Array(text.length);
  for (let i = 0; i + TOKEN_WINDOW_CHARS <= text.length; i++) {
    const end = i + TOKEN_WINDOW_CHARS;
    if (windows.has(text.slice(i, end))) covered.fill(1, i, end);
  }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (covered[i] === 0) out += text[i];
    else if (i === 0 || covered[i - 1] === 0) out += TOKEN_MARK;
  }
  return out;
}

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

/** Host and path only: the query string can carry a cursor or filter that is not ours to print. */
export function hostAndPath(url: string): string {
  const { origin, pathname } = new URL(url);
  return origin + pathname;
}

export const GITHUB_TIMEOUT_MS = 30_000;
const ERROR_BODY_SNIPPET_CHARS = 256;
const UTF8_MAX_BYTES_PER_CHAR = 4;
// A page is at most 100 items (per_page=100), each with a body of up to 65,536 characters at 4
// bytes, plus its fields.
const GITHUB_MAX_REPLY_BYTES = 32 * 1024 * 1024;

/**
 * The items of a 200 list reply. A body that is not JSON, is over the cap or is not an array
 * throws, so it never reaches ingest as items.
 */
async function readItems(res: Response, url: string, scrub: Scrub): Promise<JsonValue[]> {
  // The path only: a `next` link comes from the server, so its query string is not ours to print.
  const path = new URL(url).pathname;
  let body: JsonValue;
  try {
    body = await readCappedJson(res, GITHUB_MAX_REPLY_BYTES);
  } catch (err) {
    throw new GitHubFetchError(res.status, scrub(errorMessage(err)), path, {
      cause: safeCause(err, scrub),
    });
  }
  if (!Array.isArray(body)) {
    throw new GitHubFetchError(res.status, 'the reply is not a JSON array', path);
  }
  return body;
}

// The status is the error reported, so a body that cannot be read only costs its snippet. A body
// can echo the Authorization header, so the token is cut out before the snippet is built.
async function errorExcerpt(res: Response, scrub: Scrub): Promise<string> {
  const body = await readCappedText(res, ERROR_BODY_SNIPPET_CHARS * UTF8_MAX_BYTES_PER_CHAR).catch(
    (err) => {
      log.debug(
        `github: could not read the ${res.status} error body: ${errorMessage(err)}`,
        errorFields(err),
      );
      return '';
    },
  );
  return scrub(body).slice(0, ERROR_BODY_SNIPPET_CHARS);
}

export const realGitHubFetcher: GitHubFetcher = async ({ url, token }) => {
  // The window rule finds an echo only if the token's escaped form equals the token.
  if (!isGitHubTokenText(token)) {
    throw new Error("the GitHub token must use only letters, digits, '_', '.' and '-'");
  }
  const scrub: Scrub = (text) => redactTokenWindows(text, token);
  const res = await fetchWithRetry(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    { timeoutMs: GITHUB_TIMEOUT_MS },
  ).catch((err) => {
    // A GHES host that never answers must name itself; a bare "fetch failed" leaves the operator guessing.
    throw new Error(`GitHub request to ${hostAndPath(url)} failed: ${scrub(errorMessage(err))}`, {
      cause: safeCause(err, scrub),
    });
  });
  // A redirect to another origin would feed that server's body into this server's refs.
  const finalOrigin = res.url ? tryParseUrl(res.url)?.origin : undefined;
  if (finalOrigin !== undefined && finalOrigin !== new URL(url).origin) {
    throw new Error(`GitHub request to ${hostAndPath(url)} was redirected to ${finalOrigin}`);
  }
  const headers = headersToRecord(res.headers);
  const rateLimit = parseRateLimit(headers, res.status);

  // Don't silently turn 401/403/404/500 into empty pages.
  if (res.status !== 200 && rateLimit.reason === 'none') {
    throw new GitHubFetchError(res.status, await errorExcerpt(res, scrub), hostAndPath(url));
  }

  const items = res.status === 200 ? await readItems(res, url, scrub) : [];
  const link = res.headers.get('link') ?? '';
  const next = parseNextLink(link);
  return { items, next, rateLimit };
};
