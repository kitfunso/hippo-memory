import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GitHubFetchError,
  isGitHubTokenText,
  parseNextLink,
  realGitHubFetcher,
  redactTokenWindows,
} from '../../src/surface/connectors/github/octokit-client.js';
import { paddedJsonResponse } from '../_helpers/padded-response.js';

describe('parseNextLink', () => {
  it('parses a sole rel="next" link', () => {
    expect(parseNextLink('<https://api.github.com/x?page=2>; rel="next"')).toBe('https://api.github.com/x?page=2');
  });

  it('ignores rel="last" when no rel="next" is present', () => {
    expect(parseNextLink('<https://api.github.com/x?page=10>; rel="last"')).toBe(null);
  });

  it('returns null when the header has no rel="next"', () => {
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBe(null);
  });

  it('extracts rel="next" from a multi-rel header', () => {
    const header = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=10>; rel="last"';
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

function makeResponse(status: number, body: string, linkHeader = ''): FakeFetchResponse {
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
    await expect(realGitHubFetcher({ url: 'https://api.github.com/user', token: 'bad' })).rejects.toBeInstanceOf(
      GitHubFetchError,
    );
  });

  it('names the host and path when the request never gets a reply', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const call = realGitHubFetcher({ url: 'https://ghe.example.com/api/v3/repos/acme/app/issues?page=2', token: 't' });
    await expect(call).rejects.toThrow(
      'GitHub request to https://ghe.example.com/api/v3/repos/acme/app/issues failed: fetch failed',
    );
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply),
    );
    const outcome = await realGitHubFetcher({ url: URL_WITH_QUERY, token: 'ghp_secret' }).then(
      (page) => page,
      (err: Error) => err,
    );
    if (!(outcome instanceof GitHubFetchError)) {
      throw new Error(`expected a GitHubFetchError, got ${JSON.stringify(outcome)}`);
    }
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

  it('keeps the reason a reply stopped in mid-body', async () => {
    const stopped = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"id":'));
        controller.error(new Error('socket hang up'));
      },
    });
    const err = await failure(new Response(stopped, { status: 200 }));

    expect(err.cause).toMatchObject({ message: 'socket hang up' });
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
  });

  it('still returns the items and the next link of a well-formed page', async () => {
    const reply = new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), {
      status: 200,
      headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply),
    );
    const page = await realGitHubFetcher({ url: URL_WITH_QUERY, token: 't' });
    expect(page.items).toEqual([{ id: 1 }, { id: 2 }]);
    expect(page.next).toBe('https://api.github.com/x?page=2');
  });

  it('keeps only a short excerpt of a large error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(1024 * 1024), { status: 500 })),
    );
    const err = await realGitHubFetcher({ url: URL_WITH_QUERY, token: 't' }).then(
      () => null,
      (e: GitHubFetchError) => e,
    );
    expect(err?.status).toBe(500);
    expect(err?.bodyExcerpt).toBe('x'.repeat(256));
  });
});

describe('isGitHubTokenText', () => {
  it('accepts the characters GitHub tokens use', () => {
    expect(isGitHubTokenText('ghp_AZaz09')).toBe(true);
    expect(isGitHubTokenText('ghs_1.2-3_4')).toBe(true);
  });

  it.each(['a+b', 'a/b', 'a%b', 'a"b', 'a b', 'a\nb', 'a=b', 'a\\b', 'a&b', 'a<b', 'a~b', ''])(
    'refuses %j',
    (token) => {
      expect(isGitHubTokenText(token)).toBe(false);
    },
  );
});

describe('realGitHubFetcher with a token that has a character GitHub tokens do not use', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('throws a fixed text that never echoes the token, and sends no request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const err = await realGitHubFetcher({
      url: 'https://api.github.com/repos/a/b/issues',
      token: 'ghp_FETCHERCANARY+x',
    }).then(
      () => null,
      (e: Error) => e,
    );

    expect(err?.message).toBe("the GitHub token must use only letters, digits, '_', '.' and '-'");
    expect(err?.message).not.toContain('FETCHERCANARY');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('redactTokenWindows', () => {
  const TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';

  it('replaces each run of echoed text with one [token]', () => {
    expect(redactTokenWindows(`sent ${TOKEN}, again ${TOKEN.slice(10, 30)}.`, TOKEN)).toBe(
      'sent [token], again [token].',
    );
  });

  it('lets a fragment under 8 characters pass, as the property allows', () => {
    expect(redactTokenWindows(`got ${TOKEN.slice(0, 7)} only`, TOKEN)).toBe(`got ${TOKEN.slice(0, 7)} only`);
  });

  it('returns the text as given for a token under 8 characters', () => {
    expect(redactTokenWindows('t is a token', 't')).toBe('t is a token');
  });

  it.each(['aa[token]aa', 'a]bcdefghij', 'abcdefgh[ijklmno'])(
    'refuses the token %s, since a window could form from the marker',
    (token) => {
      expect(() => redactTokenWindows('aa[token]', token)).toThrow('a token to redact must not hold [ or ]');
    },
  );
});
