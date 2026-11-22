/** Octokit-shaped HTTP fetcher for the GitHub backfill; tests inject a fake `GitHubFetcher`. Any
 * non-200 that is not a recognised rate-limit pause MUST throw `GitHubFetchError`, since an empty
 * page would be a silent empty backfill.
 */

import { parseRateLimit, type RateLimitInfo } from './ratelimit.js';
import { fetchWithRetry } from '../../../infra/http-retry.js';
import { isJsonObject, type JsonValue } from '../../../base/util/json.js';
import { readCappedJson, readCappedText } from '../../../base/util/capped-json.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { tryParseUrl } from '../../../base/util/net.js';

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

export function staticTokenSource(token: string): GitHubTokenSource {
  return () => Promise.resolve(token);
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
async function readItems(res: Response, url: string): Promise<JsonValue[]> {
  // The path only: a `next` link comes from the server, so its query string is not ours to print.
  const path = new URL(url).pathname;
  let body: JsonValue;
  try {
    body = await readCappedJson(res, GITHUB_MAX_REPLY_BYTES);
  } catch (err) {
    throw new GitHubFetchError(res.status, errorMessage(err), path, { cause: err });
  }
  if (!Array.isArray(body)) {
    throw new GitHubFetchError(res.status, 'the reply is not a JSON array', path);
  }
  return body;
}

// The status is the error reported, so a body that cannot be read only costs its snippet. A body
// can echo the Authorization header, so the token is cut out before the snippet is built.
async function errorExcerpt(res: Response, token: string): Promise<string> {
  const body = await readCappedText(res, ERROR_BODY_SNIPPET_CHARS * UTF8_MAX_BYTES_PER_CHAR).catch(
    (err) => {
      log.debug(
        `github: could not read the ${res.status} error body: ${errorMessage(err)}`,
        errorFields(err),
      );
      return '';
    },
  );
  const clean = token === '' ? body : body.replaceAll(token, '[token]');
  return clean.slice(0, ERROR_BODY_SNIPPET_CHARS);
}

/** One GET with the GitHub headers; `redirect` says whether a 3xx is followed. */
async function githubRequest(
  url: string,
  token: string,
  redirect: RequestRedirect,
): Promise<Response> {
  return fetchWithRetry(
    url,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect,
    },
    { timeoutMs: GITHUB_TIMEOUT_MS },
  ).catch((err) => {
    // A GHES host that never answers must name itself; a bare "fetch failed" leaves the operator guessing.
    throw new Error(`GitHub request to ${hostAndPath(url)} failed: ${errorMessage(err)}`, {
      cause: err,
    });
  });
}

export const realGitHubFetcher: GitHubFetcher = async ({ url, token }) => {
  const res = await githubRequest(url, token, 'follow');
  // A redirect to another origin would feed that server's body into this server's refs.
  const finalOrigin = res.url ? tryParseUrl(res.url)?.origin : undefined;
  if (finalOrigin !== undefined && finalOrigin !== new URL(url).origin) {
    throw new Error(`GitHub request to ${hostAndPath(url)} was redirected to ${finalOrigin}`);
  }
  const headers = headersToRecord(res.headers);
  const rateLimit = parseRateLimit(headers, res.status);

  // Don't silently turn 401/403/404/500 into empty pages.
  if (res.status !== 200 && rateLimit.reason === 'none') {
    throw new GitHubFetchError(res.status, await errorExcerpt(res, token), hostAndPath(url));
  }

  const items = res.status === 200 ? await readItems(res, url) : [];
  const link = res.headers.get('link') ?? '';
  const next = parseNextLink(link);
  return { items, next, rateLimit };
};

const REDIRECT_REFUSED =
  'the redirect was refused; if the repository was renamed, pass its new name to --repo';
const NEEDS_CONTENTS_READ =
  "the token needs Contents read on this repository, or GitHub's secondary rate limit refused " +
  'the request; check the token, then retry later';

/** The error for a non-200 the strict fetchers refuse; its text is fixed, so no reply text or
 * token can reach it. */
function strictStatusError(status: number, url: string): GitHubFetchError {
  let text = 'the request failed';
  if (status >= 300 && status < 400) text = REDIRECT_REFUSED;
  else if (status === 403 || status === 404) text = NEEDS_CONTENTS_READ;
  return new GitHubFetchError(status, text, hostAndPath(url));
}

/** A 200 reply, or null res when GitHub rate limited; any other status throws fixed text. A 3xx is
 * never followed. */
async function strictReply(
  url: string,
  token: string,
): Promise<{ res: Response | null; rateLimit: RateLimitInfo }> {
  const res = await githubRequest(url, token, 'manual');
  const rateLimit = parseRateLimit(headersToRecord(res.headers), res.status);
  if (res.status === 200) return { res, rateLimit };
  await res.body?.cancel().catch((err) => {
    log.debug(`github: could not cancel the ${res.status} reply body`, errorFields(err));
  });
  if (rateLimit.reason !== 'none') return { res: null, rateLimit };
  throw strictStatusError(res.status, url);
}

// No cause is kept: a JSON parse error carries a piece of the reply.
async function readStrictJson(res: Response, url: string): Promise<JsonValue> {
  try {
    return await readCappedJson(res, GITHUB_MAX_REPLY_BYTES);
  } catch (err) {
    throw new GitHubFetchError(res.status, errorMessage(err), hostAndPath(url));
  }
}

/** A list fetcher that never follows a redirect and puts no reply text in an error. */
export const noRedirectGitHubFetcher: GitHubFetcher = async ({ url, token }) => {
  const { res, rateLimit } = await strictReply(url, token);
  if (res === null) return { items: [], next: null, rateLimit };
  const body = await readStrictJson(res, url);
  if (!Array.isArray(body)) {
    throw new GitHubFetchError(res.status, 'the reply is not a JSON array', hostAndPath(url));
  }
  return { items: body, next: parseNextLink(res.headers.get('link') ?? ''), rateLimit };
};

/** The reply to one commit request; commit is null only when GitHub rate limited. */
export interface GitHubCommitReply {
  readonly commit: Record<string, JsonValue> | null;
  readonly rateLimit: RateLimitInfo;
}

export type GitHubCommitFetcher = (args: {
  url: string;
  token: string;
}) => Promise<GitHubCommitReply>;

export const realGitHubCommitFetcher: GitHubCommitFetcher = async ({ url, token }) => {
  const { res, rateLimit } = await strictReply(url, token);
  if (res === null) return { commit: null, rateLimit };
  const body = await readStrictJson(res, url);
  if (!isJsonObject(body)) {
    throw new GitHubFetchError(res.status, 'the reply is not a JSON object', hostAndPath(url));
  }
  return { commit: body, rateLimit };
};
