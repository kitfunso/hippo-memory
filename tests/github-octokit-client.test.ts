import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GitHubFetchError,
  parseNextLink,
  realGitHubFetcher,
} from '../src/connectors/github/octokit-client.js';

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

function makeResponse(
  status: number,
  body: string,
  linkHeader = '',
): Response {
  const headers = new Headers();
  if (linkHeader) headers.set('link', linkHeader);
  return {
    status,
    headers,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

describe('realGitHubFetcher (Codex P1 #4: non-200 must throw)', () => {
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
