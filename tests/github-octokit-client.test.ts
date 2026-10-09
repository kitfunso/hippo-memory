import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GitHubFetchError,
  parseNextLink,
  realGitHubFetcher,
} from '../src/connectors/github/octokit-client.js';
import { paddedJsonResponse } from './_helpers/padded-response.js';

describe('parseNextLink', () => {
  it('parses a sole rel="next" link', () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next"')).toBe(
      'https://api.github.com/x?page=2',
    );
  });

  it('ignores rel="last" when no rel="next" is present', () => {
    expect(parseNextLink('<https://api.github.com/x?page=10>; rel="last"')).toBe(
      null,
    );
  });

  it('returns null when the header has no rel="next"', () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBe(
      null,
    );
  });

  it('extracts rel="next" from a multi-rel header', () => {
    const header =
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=10>; rel="last"';
    expect(parseNextLink(header)).toBe('https://api.github.com/x?page=2');
  });

  it('returns null on an empty header', () => {
    expect(parseNextLink('')).toBe(null);
  });
});

// A minimal structural stand-in for the fetch Response shape that
// realGitHubFetcher actually reads (status, headers, text(), json()) — this
// lets the object literal satisfy the type directly, with no assertion.
interface FakeFetchResponse {
  readonly status: number;
  readonly headers: Headers;
  text: () => Promise<string>;
  // realGitHubFetcher only reads json() on 200s, always a GitHub list payload.
  json: () => Promise<unknown[]>;
}

function makeResponse(
  status: number,
  body: string,
  linkHeader = '',
): FakeFetchResponse {
  const headers = new Headers();
  if (linkHeader) headers.set('link', linkHeader);
  return {
    status,
    headers,
    text: async () => body,
    json: async (): Promise<unknown[]> => JSON.parse(body),
  };
}

describe('realGitHubFetcher: non-200 must throw', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws GitHubFetchError on 401 Unauthorized', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(401, 'Bad credentials')),
    );
    await expect(
      realGitHubFetcher({ url: 'https://api.github.com/user', token: 'bad' }),
    ).rejects.toBeInstanceOf(GitHubFetchError);
  });

  it('throws GitHubFetchError on 404 Not Found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(404, 'Not Found')),
    );
    await expect(
      realGitHubFetcher({
        url: 'https://api.github.com/repos/x/y',
        token: 't',
      }),
    ).rejects.toBeInstanceOf(GitHubFetchError);
  });

  it('throws GitHubFetchError on 500 Server Error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(500, 'oops')),
    );
    await expect(
      realGitHubFetcher({
        url: 'https://api.github.com/repos/x/y/issues',
        token: 't',
      }),
    ).rejects.toBeInstanceOf(GitHubFetchError);
  });
});

describe('realGitHubFetcher: a 200 reply that is not a list', () => {
  const URL_WITH_QUERY = 'https://api.github.com/repos/acme/app/issues?state=all&per_page=100&since=2026-01-01';
  const GITHUB_CAP_BYTES = 32 * 1024 * 1024;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The rejection of one page fetch whose reply is `reply`; a page that came back fails the test, since ingest would take its items. */
  async function failure(reply: Response): Promise<GitHubFetchError> {
    vi.stubGlobal('fetch', vi.fn(async () => reply));
    const outcome = await realGitHubFetcher({ url: URL_WITH_QUERY, token: 'ghp_secret' }).then((page) => page, (err: Error) => err);
    if (!(outcome instanceof GitHubFetchError)) throw new Error(`expected a GitHubFetchError, got ${JSON.stringify(outcome)}`);
    return outcome;
  }

  function expectNamesTheReply(err: GitHubFetchError, reason: RegExp): void {
    expect(err.status).toBe(200);
    expect(err.message).toMatch(/^GitHub 200 on \/repos\/acme\/app\/issues: /);
    expect(err.message).toMatch(reason);
    expect(err.message).not.toMatch(/per_page|since=|ghp_/);
  }

  it('throws on an HTML error page served with status 200', async () => {
    const err = await failure(new Response('<html><body>Whoa there!</body></html>', { status: 200 }));
    expectNamesTheReply(err, /reply is not JSON/);
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('throws on a null body', async () => {
    expectNamesTheReply(await failure(new Response('null', { status: 200 })), /not a JSON array/);
  });

  it('throws on an object body, so an error document never reaches ingest as items', async () => {
    const body = JSON.stringify({ message: 'Moved Permanently', documentation_url: 'https://docs.github.com' });
    expectNamesTheReply(await failure(new Response(body, { status: 200 })), /not a JSON array/);
  });

  it('throws on a body over the byte cap', async () => {
    const err = await failure(paddedJsonResponse('[', ']', GITHUB_CAP_BYTES));
    expectNamesTheReply(err, new RegExp(`reply over ${GITHUB_CAP_BYTES} bytes`));
  }, 60_000);

  it('still returns the items and the next link of a well-formed page', async () => {
    const reply = new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200, headers: { link: '<https://api.github.com/x?page=2>; rel="next"' } });
    vi.stubGlobal('fetch', vi.fn(async () => reply));
    const page = await realGitHubFetcher({ url: URL_WITH_QUERY, token: 't' });
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page.next).toBe('https://api.github.com/x?page=2');
  });

  it('keeps only a short excerpt of a large error body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1024 * 1024), { status: 500 })));
    const err = await realGitHubFetcher({ url: URL_WITH_QUERY, token: 't' }).then(() => null, (e: GitHubFetchError) => e);
    expect(err?.status).toBe(500);
    expect(err?.bodyExcerpt).toBe('x'.repeat(256));
  });
});
