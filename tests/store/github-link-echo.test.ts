/** A GitHub reply chooses the `Link` next URL, and an echo of the token in it once reached the error, the log and stderr.
 * A loopback server sends page 1 with such a link; the fetcher must refuse it whole, so page 2 is never asked for
 * and no 8-character window of the token reaches the error, a log line or the CLI output. */

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realGitHubFetcher } from '../../src/surface/connectors/github/octokit-client.js';
import { chainText, tokenWindows } from '../_helpers/github-token-leak.js';
import { makeStore } from '../_helpers/make-root.js';
import { runCliAs } from '../_helpers/run-cli-as.js';

const WINDOW = 8;
const { privateKey: APP_KEY } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PAT = 'ghp_LINKECHOCANARY0123456789abcdefghijklmn';
const MINTED = 'ghs_LINKMINTEDCANARY0123456789abcdefghijklm';
const REFUSAL = 'returned a next-page link that carries the token';

type Page2 = (res: ServerResponse) => void;

const PAGE2: ReadonlyArray<readonly [string, Page2]> = [
  ['a 404', (res) => res.writeHead(404).end('not found')],
  ['a 200 that is not JSON', (res) => res.writeHead(200).end('not json at all')],
  ['a dropped socket', (res) => res.socket?.destroy()],
  ['a 503', (res) => res.writeHead(503).end('unavailable')],
];

interface LinkServer {
  readonly url: string;
  readonly page2Requests: string[];
  readonly bearers: string[];
  close(): Promise<void>;
}

/** Page 1 of every list is `[]` with `next(origin)` as its link; a request for a path under /echo/ is page 2. */
async function serveLinks(next: (origin: string) => string, page2: Page2): Promise<LinkServer> {
  const page2Requests: string[] = [];
  const bearers: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    bearers.push(req.headers.authorization?.replace('Bearer ', '') ?? '');
    if (req.method === 'POST' && path.endsWith('/access_tokens')) {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      res.writeHead(201).end(JSON.stringify({ token: MINTED, expires_at: expiresAt }));
    } else if (path.endsWith('/installation')) {
      res.writeHead(200).end(JSON.stringify({ id: 42 }));
    } else if (path.includes('/echo/')) {
      page2Requests.push(path);
      page2(res);
    } else {
      // SAFETY: a server listening on TCP has an AddressInfo.
      const { port } = server.address() as AddressInfo;
      res.writeHead(200, { link: `<${next(`http://127.0.0.1:${port}`)}>; rel="next"` }).end('[]');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: as above.
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    page2Requests,
    bearers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const samePath = (token: string) => (origin: string) =>
  `${origin}/api/v3/repos/acme/demo/issues/echo/${token}/x?page=2`;
const otherHost = (token: string) => () => `http://${token}.example.test/api/v3/repos/acme/demo/issues?page=2`;

async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error('the fetch did not fail');
}

const leaked = (text: string, secret: string): string[] => tokenWindows(secret, WINDOW).filter((w) => text.includes(w));

describe('a Link next URL that echoes the token', () => {
  let server: LinkServer | undefined;

  beforeEach(() => {
    vi.stubEnv('HIPPO_LOG', 'debug');
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function backfill(
    auth: 'pat' | 'app',
    url: string,
  ): Promise<{ stdout: string; stderr: string; status: number }> {
    const { base, root } = makeStore('gh-link-echo');
    const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: root, HIPPO_LOG: 'debug', GITHUB_ENTERPRISE_URL: url };
    if (auth === 'pat') {
      env.GITHUB_TOKEN = PAT;
    } else {
      const pem = join(base, 'app.pem');
      writeFileSync(pem, APP_KEY.export({ type: 'pkcs8', format: 'pem' }));
      Object.assign(env, { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_FILE: pem });
      delete env.GITHUB_TOKEN;
    }
    const r = await runCliAs(['github', 'backfill', '--repo', 'acme/demo'], { cwd: base, env });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  }

  const cases = (['pat', 'app'] as const).flatMap((auth) => [
    ...PAGE2.map(([name, page2]) => ({ auth, where: `same-origin path, page 2 is ${name}`, page2, link: samePath })),
    { auth, where: 'other-origin host', page2: PAGE2[0]![1], link: otherHost },
  ]);

  it.each(cases)('for $auth auth refuses a link with the token in its $where', async ({ auth, page2, link }) => {
    const token = auth === 'pat' ? PAT : MINTED;
    server = await serveLinks(link(token), page2);

    const r = await backfill(auth, server.url);
    const shown = `${r.stdout}\n${r.stderr}`;
    const jwts = server.bearers.filter((b) => b !== PAT && b !== MINTED);

    expect(r.status).toBe(3);
    expect(r.stderr).toContain('backfill failed:');
    expect(r.stderr).toContain(REFUSAL);
    expect(server.page2Requests).toEqual([]);
    expect(leaked(shown, token)).toEqual([]);
    for (const jwt of jwts) expect(leaked(shown, jwt)).toEqual([]);
  });

  it.each([
    ['same-origin path', samePath],
    ['other-origin host', otherHost],
  ])('names only the request host and path in the fetcher error for an %s echo', async (_where, link) => {
    server = await serveLinks(link(PAT), PAGE2[0]![1]);
    const url = `${server.url}/api/v3/repos/acme/demo/issues?page=1`;

    const err = await failureOf(realGitHubFetcher({ url, token: PAT }));

    expect(err.message).toBe(`GitHub request to ${server.url}/api/v3/repos/acme/demo/issues ${REFUSAL}`);
    expect(leaked(chainText(err), PAT)).toEqual([]);
  });
});
