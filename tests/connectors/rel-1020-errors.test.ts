import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubFetchError, realGitHubFetcher } from '../../src/surface/connectors/github/octokit-client.js';
import { isSleepReply } from '../../src/surface/server/sleep-offload.js';

describe('a GitHub error whose body cannot be read', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('still throws the status, with the URL cut to host and path', async () => {
    const broken = new ReadableStream<Uint8Array>({ start: (c) => c.error(new Error('connection reset')) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(broken, { status: 404 })),
    );
    let err: GitHubFetchError | undefined;
    try {
      await realGitHubFetcher({
        url: 'https://api.github.com/repos/acme/app/issues?since=2026-01-01&page=3',
        token: 't',
      });
    } catch (caught) {
      if (caught instanceof GitHubFetchError) err = caught;
    }
    if (!err) throw new Error('expected a GitHubFetchError');
    expect(err.status).toBe(404);
    expect(err.bodyExcerpt).toBe('');
    expect(err.url).toBe('https://api.github.com/repos/acme/app/issues');
    expect(err.message).not.toContain('since=');
  });
});

describe('isSleepReply', () => {
  it('accepts the two shapes sleep-child sends', () => {
    expect(isSleepReply({ ok: true, result: { consolidated: 1 } })).toBe(true);
    expect(isSleepReply({ ok: false, busy: true, message: 'locked' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'done'],
    ['no ok flag', { result: {} }],
    ['ok without a result', { ok: true }],
    ['a failure without a message', { ok: false, busy: false }],
    ['a failure with a numeric busy', { ok: false, busy: 1, message: 'x' }],
  ])('rejects %s', (_name, value) => {
    expect(isSleepReply(value)).toBe(false);
  });
});
