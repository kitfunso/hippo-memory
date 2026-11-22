// Runs the real GitHub fetcher on a fake reply and reads what it throws, for tests that look for token text in an error.
import { inspect } from 'node:util';
import { vi } from 'vitest';
import { realGitHubFetcher } from '../../src/surface/connectors/github/octokit-client.js';

/** Every run of `size` characters of the token. */
export function tokenWindows(token: string, size: number): string[] {
  return Array.from({ length: Math.max(0, token.length - size + 1) }, (_, i) => token.slice(i, i + size));
}

/** The message and stack of an error and of every cause behind it, then what `util.inspect` prints, which shows every own field of every link. */
export function chainText(err: Error): string {
  const parts: string[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) parts.push(e.message, e.stack ?? '');
  parts.push(inspect(err, { depth: null }));
  return parts.join('\n');
}

/** The error one page fetch throws when GitHub answers `body` with `status`; the caller unstubs fetch. */
export async function failureFor(body: string, status: number, token: string): Promise<Error> {
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
