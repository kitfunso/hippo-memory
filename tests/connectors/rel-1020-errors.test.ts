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

describe('a GitHub error whose body echoes the token', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('holds [token] in the message and the stack, never the token', async () => {
    const canary = 'ghs_TOKENCANARY123';
    const echoed = `you sent Bearer ${canary}, again ${canary}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(echoed, { status: 400 })),
    );
    let err: GitHubFetchError | undefined;
    try {
      await realGitHubFetcher({ url: 'https://api.github.com/repos/acme/app/issues', token: canary });
    } catch (caught) {
      if (caught instanceof GitHubFetchError) err = caught;
    }
    if (!err) throw new Error('expected a GitHubFetchError');
    expect(err.message).toContain('you sent Bearer [token], again [token]');
    expect(err.message).not.toContain(canary);
    expect(err.stack).toContain('[token]');
    expect(err.stack).not.toContain(canary);
  });
});

const PAT = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-';
// A repeating token would let a cut copy match the whole token at a shifted offset.
const LONG_TOKEN = `ghs_${Array.from({ length: 516 }, (_, i) => TOKEN_CHARS[(i * i * 7 + i * 13 + (i >> 3)) % TOKEN_CHARS.length]).join('')}`;

function tokenWindows(token: string): string[] {
  return Array.from({ length: token.length - 11 }, (_, i) => token.slice(i, i + 12));
}

function chainText(err: Error): string {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message, e.stack ?? '');
  return parts.join('\n');
}

function expectNoWindow(text: string, token: string): void {
  expect(tokenWindows(token).filter((w) => text.includes(w))).toEqual([]);
}

async function failureFor(body: string, status: number, token: string): Promise<Error> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, { status })),
  );
  try {
    await realGitHubFetcher({ url: 'https://api.github.com/repos/acme/app/issues', token });
  } catch (caught) {
    if (caught instanceof Error) return caught;
  }
  throw new Error('expected an error');
}

describe('a GitHub error body that the read cap cuts through a token copy', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['30 copies of a PAT after 20 filler characters', `${'x'.repeat(20)}${`${PAT} `.repeat(30)}`, PAT],
    ['a 520-character token echoed twice', `${LONG_TOKEN}${LONG_TOKEN}`, LONG_TOKEN],
    ['169 CJK characters then one echo of a 520-character token', `${'中'.repeat(169)}${LONG_TOKEN}`, LONG_TOKEN],
  ])('keeps no 12-character window of the token for %s', async (_name, body, token) => {
    const err = await failureFor(body, 400, token);

    expectNoWindow(chainText(err), token);
  });
});

describe('a 200 list reply that is not JSON', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('carries no cause, so no part of an echoed token reaches the error', async () => {
    const err = await failureFor(`${PAT} not json`, 200, PAT);

    expect(err).toBeInstanceOf(GitHubFetchError);
    expect(err.message).toContain('reply is not JSON');
    expect(err.cause).toBeUndefined();
    expectNoWindow(chainText(err), PAT);
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
