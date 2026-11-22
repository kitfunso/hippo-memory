/** A reply that breaks HTTP framing makes fetch throw an error whose parser cause keeps the raw reply bytes in `data`.
 * A raw TCP server sends such replies that echo a token; no 8-character window of it may reach the inspected error,
 * a log line or the CLI's stderr, and the error must still name what failed. */

import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { inspect } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorFields, errorMessage, log } from '../../src/base/util/log.js';
import { appTokenSource } from '../../src/surface/connectors/github/app-auth.js';
import { GitHubFetchError, realGitHubFetcher } from '../../src/surface/connectors/github/octokit-client.js';
import { parseGitHubEnterpriseUrl } from '../../src/surface/connectors/github/site.js';
import { tokenWindows } from '../_helpers/github-token-leak.js';
import { makeStore } from '../_helpers/make-root.js';
import { runCliAs } from '../_helpers/run-cli-as.js';

const REPO = 'acme/demo';
const WINDOW = 8;
const CANARY = 'ghp_STREAMCANARY0123456789abcdefghijklmnop';
const MINTED = 'ghs_MINTEDCANARY0123456789abcdefghijklmnop';

const CHUNKED = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n';
const malformedChunk = (secret: string): string => `${CHUNKED}ZZ ${secret} is not a chunk size\r\n`;
const malformedHeader = (secret: string): string =>
  `HTTP/1.1 200 OK\r\nBad ${secret} header line\r\nContent-Length: 2\r\n\r\n[]`;

interface RawServer {
  readonly url: string;
  close(): Promise<void>;
}

/** A TCP server that answers the first request head on each connection with `reply(head)` as raw bytes. */
async function serve(reply: (head: string) => string): Promise<RawServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (err) => log.debug(`raw server socket: ${err.message}`));
    let head = '';
    socket.on('data', (chunk) => {
      head += String(chunk);
      if (head.includes('\r\n\r\n')) socket.write(reply(head), () => setTimeout(() => socket.destroy(), 50));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on TCP reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const bearerOf = (head: string): string => /^authorization: Bearer (\S+)/im.exec(head)?.[1] ?? '';

async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error('the call did not fail');
}

const leaked = (text: string, secret: string): string[] => tokenWindows(secret, WINDOW).filter((w) => text.includes(w));

describe('a reply with broken framing that echoes a secret', () => {
  let raw: RawServer | undefined;
  const written: string[] = [];

  beforeEach(() => {
    vi.stubEnv('HIPPO_LOG', 'debug');
    written.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
  });
  afterEach(async () => {
    await raw?.close();
    raw = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // What an operator or a crash printer shows: every field of every link, then the warn line the CLI writes.
  function shown(err: Error): string {
    log.warn(`github backfill failed: ${errorMessage(err)}`, errorFields(err));
    return `${inspect(err, { depth: null })}\n${written.join('')}`;
  }

  it.each([
    ['a malformed chunk', malformedChunk(CANARY), 'terminated'],
    ['a malformed header', malformedHeader(CANARY), 'fetch failed'],
  ])(
    'keeps no window of the token from %s in the list fetch, and still names the failure',
    async (_name, bytes, reason) => {
      raw = await serve(() => bytes);
      const err = await failureOf(
        realGitHubFetcher({ url: `${raw.url}/api/v3/repos/acme/demo/issues`, token: CANARY }),
      );
      const text = shown(err);

      expect(text).toContain(reason);
      expect(text).toContain('HTTPParserError');
      expect(leaked(text, CANARY)).toEqual([]);
    },
  );

  it('keeps no window of the token from a malformed chunk in the CLI stderr', async () => {
    const { base, root } = makeStore('gh-stream-cause');
    raw = await serve(() => malformedChunk(CANARY));
    vi.restoreAllMocks();
    const r = await runCliAs(['github', 'backfill', '--repo', REPO], {
      cwd: base,
      env: { ...process.env, HIPPO_HOME: root, GITHUB_ENTERPRISE_URL: raw.url, GITHUB_TOKEN: CANARY },
    });

    expect(r.status).toBe(3);
    expect(r.stderr).toContain('backfill failed:');
    expect(r.stderr).toContain('terminated');
    expect(leaked(`${r.stdout}\n${r.stderr}`, CANARY)).toEqual([]);
  });

  it('keeps a GitHubFetchError status and path on the chunk failure', async () => {
    raw = await serve(() => malformedChunk(CANARY));
    const err = await failureOf(
      realGitHubFetcher({ url: `${raw.url}/api/v3/repos/acme/demo/issues?page=2`, token: CANARY }),
    );

    expect(err).toBeInstanceOf(GitHubFetchError);
    expect(err).toMatchObject({ status: 200, url: '/api/v3/repos/acme/demo/issues' });
    expect(err.cause).toMatchObject({ name: 'TypeError', message: 'terminated' });
  });

  it('names the failing host in the list fetch error for a malformed header', async () => {
    raw = await serve(() => malformedHeader(CANARY));
    const err = await failureOf(realGitHubFetcher({ url: `${raw.url}/api/v3/repos/acme/demo/issues`, token: CANARY }));

    expect(err.message).toBe(`GitHub request to ${raw.url}/api/v3/repos/acme/demo/issues failed: fetch failed`);
    expect(err.cause).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
  });

  describe('from the App token mint', () => {
    let privateKey: KeyObject;

    beforeAll(() => {
      ({ privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
    });

    const mintFrom = (url: string): Promise<string> =>
      appTokenSource({
        appId: '123',
        privateKey,
        installationId: '42',
        site: parseGitHubEnterpriseUrl(url),
        repoFullName: REPO,
      })();

    it('keeps no window of the App JWT from a malformed header, and names the host', async () => {
      let jwt = '';
      raw = await serve((head) => {
        jwt = bearerOf(head);
        return malformedHeader(jwt);
      });
      const err = await failureOf(mintFrom(raw.url));
      const text = shown(err);

      expect(jwt.length).toBeGreaterThan(100);
      expect(text).toContain(`GitHub App token request to ${raw.url}/api/v3/app/installations/42/access_tokens failed`);
      expect(text).toContain('fetch failed');
      expect(leaked(text, jwt)).toEqual([]);
    });

    it('keeps the reason a mint reply stopped in mid-body, and no window of the minted token', async () => {
      raw = await serve(() => malformedChunk(MINTED).replace('200 OK', '201 Created'));
      const err = await failureOf(mintFrom(raw.url));
      const text = shown(err);

      expect(err.message).toBe(
        `GitHub App token reply from ${raw.url}/api/v3/app/installations/42/access_tokens has no token or expiry`,
      );
      expect(err.cause).toMatchObject({ name: 'TypeError', message: 'terminated' });
      expect(leaked(text, MINTED)).toEqual([]);
    });
  });
});
