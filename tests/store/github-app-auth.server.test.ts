/** GitHub App auth for the backfill: a real RSA key, a fake GHES on loopback, the real fetcher and
 * store. Clocks are injected, so no case waits an hour. */

import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { backfillRepo } from '../../src/surface/connectors/github/backfill.js';
import {
  appTokenSource,
  installationTokenUrl,
  repoInstallationUrl,
} from '../../src/surface/connectors/github/app-auth.js';
import {
  realGitHubFetcher,
  type GitHubFetcher,
  type GitHubTokenSource,
} from '../../src/surface/connectors/github/octokit-client.js';
import { GITHUB_COM, parseGitHubEnterpriseUrl } from '../../src/surface/connectors/github/site.js';
import type { FullContext } from '../_helpers/api-ctx.js';
import {
  startFakeGitHub,
  type FakeGitHub,
  type FakeGitHubOptions,
  type FakeRequest,
} from '../_helpers/fake-github-server.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';

const { apiCtx } = sessionPerTest();

const REPO = 'acme/demo';
const TENANT = 'default';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T = Date.parse('2026-11-22T12:00:00Z');
const MINT_PATH = '/api/v3/app/installations/42/access_tokens';
const LOOKUP_PATH = '/api/v3/repos/acme/demo/installation';
const INSTALLATION_HINT =
  "; set GITHUB_APP_INSTALLATION_ID, use the repository's current name, or check that the App is installed on it.";
const UNAUTHORIZED_HINT = "; check GITHUB_APP_ID, the key file and this machine's clock.";
const RETRY_HINT = '; GitHub is unavailable or rate limited, so try again later.';

let privateKey: KeyObject;
let publicKey: KeyObject;
let privatePem: string;

beforeAll(() => {
  ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
});

const iso = (ms: number): string => new Date(ms).toISOString();
const mints = (f: FakeGitHub): FakeRequest[] => f.requests.filter((r) => r.method === 'POST');
const lookups = (f: FakeGitHub): FakeRequest[] => f.requests.filter((r) => r.path.endsWith('/installation'));
const lists = (f: FakeGitHub): FakeRequest[] =>
  f.requests.filter((r) => r.path.startsWith('/api/v3/repos/') && !r.path.endsWith('/installation'));
const elsewhere = (f: FakeGitHub): FakeRequest[] => f.requests.filter((r) => r.path === '/elsewhere');
const bearers = (requests: FakeRequest[]): Array<string | undefined> => requests.map((r) => r.authorization);

interface Clocks {
  readonly state: { wall: number; mono: number };
  readonly wall: () => number;
  readonly mono: () => number;
}

function clocks(): Clocks {
  const state = { wall: T, mono: 5_000_000 };
  return { state, wall: () => state.wall, mono: () => state.mono };
}

interface DecodedJwt {
  header: { alg: string; typ: string };
  payload: { iss: number | string; iat: number; exp: number };
  verifies: boolean;
}

function decodeJwt(authorization: string | undefined): DecodedJwt {
  const [head = '', body = '', sig = ''] = (authorization ?? '').replace(/^Bearer /, '').split('.');
  const signed = Buffer.from(`${head}.${body}`);
  return {
    header: JSON.parse(Buffer.from(head, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(body, 'base64url').toString()),
    verifies: verify('sha256', signed, publicKey, Buffer.from(sig, 'base64url')),
  };
}

interface CursorRow {
  issues_hwm: string | null;
  issue_comments_hwm: string | null;
  pr_review_comments_hwm: string | null;
}

function readCursors(root: string): CursorRow[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: sql is a literal SELECT of exactly CursorRow's three columns from the github_cursors schema.
    return db
      .prepare(
        `SELECT issues_hwm, issue_comments_hwm, pr_review_comments_hwm
         FROM github_cursors WHERE tenant_id = ?`,
      )
      .all(TENANT) as CursorRow[];
  } finally {
    closeHippoDb(db);
  }
}

async function failureOf(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error('the run did not fail');
}

describe('GitHub App token source in backfillRepo', () => {
  let root: string;
  let fake: FakeGitHub | undefined;

  beforeEach(() => {
    root = makeRoot('gh-app');
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  const ctx = (): FullContext => apiCtx(root, TENANT, { subject: 'connector:github', role: 'admin' });

  async function serve(options?: FakeGitHubOptions): Promise<FakeGitHub> {
    fake = await startFakeGitHub(options);
    return fake;
  }

  function sourceFor(f: FakeGitHub, c: Clocks, installationId?: string): GitHubTokenSource {
    return appTokenSource({
      appId: '123',
      privateKey,
      installationId,
      site: parseGitHubEnterpriseUrl(f.url),
      repoFullName: REPO,
      wall: c.wall,
      mono: c.mono,
    });
  }

  function run(f: FakeGitHub, tokenSource: GitHubTokenSource): ReturnType<typeof backfillRepo> {
    const site = parseGitHubEnterpriseUrl(f.url);
    return backfillRepo(ctx(), { repoFullName: REPO, fetcher: realGitHubFetcher, tokenSource, site });
  }

  // Stream 2's comment request is the last one before stream 3 asks the source for its token.
  const atStream2 = (move: () => void): FakeGitHubOptions => ({
    onRequest: (method, path) => {
      if (method === 'GET' && path.includes('/issues/comments')) move();
    },
  });

  it('A1. mints one token from a verifiable App JWT, and every API request carries that token', async () => {
    const f = await serve();
    // github.com now issues stateless tokens shaped like a JWT, so dots, dashes and underscores must pass.
    const stateless = 'ghs_123_eyJhbGc-iOi_J9.eyJpc3M-iOj_F9.c2ln-bmF0_dXJl';
    f.mintReplies.push({ status: 201, token: stateless, expiresAt: iso(T + HOUR) });
    await run(f, sourceFor(f, clocks(), '42'));

    expect(bearers(lists(f))).toEqual(Array(3).fill(`Bearer ${stateless}`));
    const [mint] = mints(f);
    expect(mint.path).toBe(MINT_PATH);
    expect(mint.contentType).toBe('application/json');
    const jwt = decodeJwt(mint.authorization);
    expect(jwt.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(jwt.payload).toEqual({ iss: 123, iat: T / 1000 - 60, exp: T / 1000 + 540 });
    expect(jwt.verifies).toBe(true);
  });

  it('A2. a token inside the re-mint margin is replaced; a fresh one is reused', async () => {
    const f = await serve();
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + 4 * MINUTE) },
      { status: 201, token: 'ghs_2', expiresAt: iso(T + HOUR) },
    );
    await run(f, sourceFor(f, clocks(), '42'));

    expect(bearers(lists(f))).toEqual(['Bearer ghs_1', 'Bearer ghs_2', 'Bearer ghs_2']);
    expect(mints(f)).toHaveLength(2);
    expect(mints(f).map((m) => m.body)).toEqual(Array(2).fill('{"repositories":["demo"]}'));
  });

  it('A2b. a clock behind GitHub still re-mints on the one-hour cap', async () => {
    const c = clocks();
    const f = await serve(
      atStream2(() => {
        c.state.mono += 56 * MINUTE;
        c.state.wall += 56 * MINUTE;
      }),
    );
    // GitHub's clock is 7 minutes ahead of ours, so its expires_at is 67 minutes out.
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + 67 * MINUTE) },
      { status: 201, token: 'ghs_2', expiresAt: iso(T + 56 * MINUTE + HOUR) },
    );
    await run(f, sourceFor(f, c, '42'));

    expect(bearers(lists(f))).toEqual(['Bearer ghs_1', 'Bearer ghs_1', 'Bearer ghs_2']);
    expect(mints(f)).toHaveLength(2);
  });

  it('A2c. a mint that fails mid-run stops the run, keeps stream 1 and leaks no body', async () => {
    const f = await serve();
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + 4 * MINUTE) },
      { status: 401, body: 'BODY-CANARY' },
    );
    const err = await failureOf(run(f, sourceFor(f, clocks(), '42')));

    expect(err.message).toBe(`GitHub App token request to ${f.url}${MINT_PATH} failed: HTTP 401${UNAUTHORIZED_HINT}`);
    expect(err.message).not.toContain('BODY-CANARY');
    const [cursor, ...rest] = readCursors(root);
    expect(rest).toEqual([]);
    expect(cursor.issues_hwm).not.toBeNull();
    expect(cursor.issue_comments_hwm).toBeNull();
    expect(cursor.pr_review_comments_hwm).toBeNull();
  });

  it('A2d. a machine that slept re-mints, though its monotonic clock did not move', async () => {
    const c = clocks();
    const f = await serve(
      atStream2(() => {
        c.state.wall += 56 * MINUTE;
      }),
    );
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + HOUR) },
      { status: 201, token: 'ghs_2', expiresAt: iso(T + 56 * MINUTE + HOUR) },
    );
    await run(f, sourceFor(f, c, '42'));

    expect(bearers(lists(f))).toEqual(['Bearer ghs_1', 'Bearer ghs_1', 'Bearer ghs_2']);
    expect(mints(f)).toHaveLength(2);
  });

  it('A2f. with the wall clock stopped, the monotonic deadline still re-mints', async () => {
    const c = clocks();
    const f = await serve(
      atStream2(() => {
        c.state.mono += 56 * MINUTE;
      }),
    );
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + HOUR) },
      { status: 201, token: 'ghs_2', expiresAt: iso(T + HOUR) },
    );
    await run(f, sourceFor(f, c, '42'));

    expect(bearers(lists(f))).toEqual(['Bearer ghs_1', 'Bearer ghs_1', 'Bearer ghs_2']);
    expect(mints(f)).toHaveLength(2);
  });

  it('A2g. a machine that sleeps during the mint counts the wall deadline from the mint start', async () => {
    const c = clocks();
    let mintsSeen = 0;
    const f = await serve({
      onRequest: (method, path) => {
        // The monotonic clock stays put, as when the machine sleeps with the first mint's reply unsent.
        if (method === 'POST' && (mintsSeen += 1) === 1) c.state.wall += 30 * MINUTE;
        if (method === 'GET' && path.includes('/issues/comments')) c.state.wall += 26 * MINUTE;
      },
    });
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + HOUR) },
      { status: 201, token: 'ghs_2', expiresAt: iso(T + 56 * MINUTE + HOUR) },
    );
    await run(f, sourceFor(f, c, '42'));

    expect(bearers(lists(f))).toEqual(['Bearer ghs_1', 'Bearer ghs_1', 'Bearer ghs_2']);
    expect(mints(f)).toHaveLength(2);
  });

  it('A2e. a rate-limited page asks the token source again before its retry', async () => {
    let asks = 0;
    const tokenSource: GitHubTokenSource = () => Promise.resolve(`t${(asks += 1)}`);
    const tokens: string[] = [];
    let limited = false;
    const fetcher: GitHubFetcher = ({ token }) => {
      tokens.push(token);
      const rateLimit = limited
        ? { sleepSeconds: 0, reason: 'none' as const }
        : { sleepSeconds: 1, reason: 'secondary' as const };
      limited = true;
      return Promise.resolve({ items: [], next: null, rateLimit });
    };
    await backfillRepo(ctx(), {
      repoFullName: REPO,
      fetcher,
      tokenSource,
      sleepMs: () => Promise.resolve(),
    });

    expect(tokens).toEqual(['t1', 't2', 't3', 't4']);
    expect(asks).toBe(4);
  });

  it('A3. with no installation id, one lookup serves every mint', async () => {
    const f = await serve();
    f.mintReplies.push(
      { status: 201, token: 'ghs_1', expiresAt: iso(T + 4 * MINUTE) },
      { status: 201, token: 'ghs_2', expiresAt: iso(T + HOUR) },
    );
    await run(f, sourceFor(f, clocks()));

    expect(mints(f)).toHaveLength(2);
    expect(mints(f).map((m) => m.path)).toEqual([MINT_PATH, MINT_PATH]);
    expect(lookups(f)).toHaveLength(1);
    expect(lookups(f)[0].path).toBe(LOOKUP_PATH);
    expect(decodeJwt(lookups(f)[0].authorization).verifies).toBe(true);
  });

  it('A5. a failed mint names the host and status only, without redirect or body', async () => {
    const f = await serve();
    f.mintReplies.push({ status: 401, body: 'BODY-CANARY' });
    const err = await failureOf(run(f, sourceFor(f, clocks(), '42')));

    expect(err.message).toBe(`GitHub App token request to ${f.url}${MINT_PATH} failed: HTTP 401${UNAUTHORIZED_HINT}`);
    expect(err.message).not.toContain('BODY-CANARY');
    expect(err.cause).toBeUndefined();
    expect(lists(f)).toEqual([]);
    expect(readCursors(root)).toEqual([]);
  });

  it('A5. a mint that redirects is not followed', async () => {
    const f = await serve();
    f.mintReplies.push({ status: 302, location: '/elsewhere', body: 'BODY-CANARY' });
    const err = await failureOf(run(f, sourceFor(f, clocks(), '42')));

    expect(err.message).toBe(`GitHub App token request to ${f.url}${MINT_PATH} failed: HTTP 302`);
    expect(elsewhere(f)).toEqual([]);
    expect(lists(f)).toEqual([]);
  });

  it.each([
    [404, undefined],
    [302, '/elsewhere'],
  ])('A5. a lookup answered %i fails with the fixed text, no mint, no redirect, no body', async (status, location) => {
    const f = await serve();
    f.lookupReplies.splice(0, 1, { status, body: 'BODY-CANARY', location });
    const err = await failureOf(run(f, sourceFor(f, clocks())));

    expect(err.message).toBe(
      `GitHub App installation lookup at ${f.url}${LOOKUP_PATH} failed: HTTP ${status}${INSTALLATION_HINT}`,
    );
    expect(err.message).not.toContain('BODY-CANARY');
    expect(mints(f)).toEqual([]);
    expect(elsewhere(f)).toEqual([]);
  });

  it.each([503, 429])(
    'A5. a lookup answered %i says to try again later, not to set the installation id',
    async (status) => {
      const f = await serve();
      f.lookupReplies.splice(0, 1, { status, body: 'BODY-CANARY' });
      const err = await failureOf(run(f, sourceFor(f, clocks())));

      expect(err.message).toBe(
        `GitHub App installation lookup at ${f.url}${LOOKUP_PATH} failed: HTTP ${status}${RETRY_HINT}`,
      );
      expect(err.message).not.toContain('BODY-CANARY');
      expect(mints(f)).toEqual([]);
    },
  );

  it('A5. a lookup answered 401 points at the App ID, the key and the clock, without the body', async () => {
    const f = await serve();
    f.lookupReplies.splice(0, 1, { status: 401, body: 'BODY-CANARY' });
    const err = await failureOf(run(f, sourceFor(f, clocks())));

    expect(err.message).toBe(
      `GitHub App installation lookup at ${f.url}${LOOKUP_PATH} failed: HTTP 401${UNAUTHORIZED_HINT}`,
    );
    expect(err.message).not.toContain('BODY-CANARY');
    expect(mints(f)).toEqual([]);
  });

  it.each([
    ['a 201 without a token', { status: 201, expiresAt: iso(T + HOUR) }],
    ['an expiry that is not a date', { status: 201, token: 'ghs_x', expiresAt: 'not-a-date' }],
    ['an expiry before the mint started', { status: 201, token: 'ghs_x', expiresAt: iso(T - MINUTE) }],
    ['a body that is not JSON', { status: 201, body: 'not json BODY-CANARY' }],
  ])('A8. a mint reply with %s fails with the fixed text and no API request', async (_name, reply) => {
    const f = await serve();
    f.mintReplies.push(reply);
    const err = await failureOf(run(f, sourceFor(f, clocks(), '42')));

    expect(err.message).toBe(`GitHub App token reply from ${f.url}${MINT_PATH} has no token or expiry`);
    expect(err.cause).toBeUndefined();
    expect(lists(f)).toEqual([]);
  });

  it('A8. a mint reply whose token cannot go in a header fails with the fixed text and leaks no part of it', async () => {
    vi.stubEnv('HIPPO_LOG', 'debug');
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const f = await serve();
    f.mintReplies.push({ status: 201, token: 'ghs_a\nb', expiresAt: iso(T + HOUR) });
    let err: Error;
    try {
      err = await failureOf(run(f, sourceFor(f, clocks(), '42')));
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }

    expect(err.message).toBe(`GitHub App token reply from ${f.url}${MINT_PATH} has no token or expiry`);
    expect(err.cause).toBeUndefined();
    expect(lists(f)).toEqual([]);
    expect(err.message).not.toContain('ghs_a');
    expect(written.join('')).not.toContain('ghs_a');
  });
});

describe('GitHub App URLs', () => {
  it('A7. both URLs start at the site API base', () => {
    expect(installationTokenUrl(GITHUB_COM, '42')).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(repoInstallationUrl(GITHUB_COM, 'acme/demo')).toBe('https://api.github.com/repos/acme/demo/installation');
    const ghes = parseGitHubEnterpriseUrl('https://ghes.example.com');
    expect(installationTokenUrl(ghes, '42')).toBe('https://ghes.example.com/api/v3/app/installations/42/access_tokens');
    expect(repoInstallationUrl(ghes, 'acme/demo')).toBe('https://ghes.example.com/api/v3/repos/acme/demo/installation');
  });
});

describe('hippo github backfill with App settings', () => {
  let base: string;
  let hippoRoot: string;
  let fake: FakeGitHub | undefined;

  beforeEach(() => {
    ({ base, root: hippoRoot } = makeStore('gh-app-cli'));
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  const keyFile = (text: string = privatePem): string => {
    const file = join(base, 'app.pem');
    writeFileSync(file, text);
    return file;
  };

  async function backfillWith(env: Record<string, string>): ReturnType<typeof runCliAs> {
    fake = await startFakeGitHub();
    return runCliAs(['github', 'backfill', '--repo', REPO], {
      cwd: base,
      env: { ...process.env, HIPPO_HOME: hippoRoot, GITHUB_ENTERPRISE_URL: fake.url, ...env },
    });
  }

  it('A4. an App ID without a key file exits 2 before any request', async () => {
    const r = await backfillWith({ GITHUB_APP_ID: '123' });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      'GitHub App settings are incomplete: set GITHUB_APP_PRIVATE_KEY_FILE, or unset the GITHUB_APP_ variables.',
    );
    expect(fake?.requests).toEqual([]);
  });

  it('A4. a key file without an App ID exits 2 naming GITHUB_APP_ID', async () => {
    const r = await backfillWith({ GITHUB_APP_PRIVATE_KEY_FILE: keyFile() });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      'GitHub App settings are incomplete: set GITHUB_APP_ID, or unset the GITHUB_APP_ variables.',
    );
    expect(fake?.requests).toEqual([]);
  });

  it('A4. a key file that cannot be read exits 2 naming the variable, not the path', async () => {
    const missing = join(base, 'missing.pem');
    const r = await backfillWith({ GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_FILE: missing });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GITHUB_APP_PRIVATE_KEY_FILE cannot be read (ENOENT).');
    expect(r.stderr).not.toContain('missing.pem');
    expect(fake?.requests).toEqual([]);
  });

  it('A4. a key file that is not a key exits 2 without quoting it', async () => {
    const r = await backfillWith({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile('NOT-A-KEY-CANARY'),
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GITHUB_APP_PRIVATE_KEY_FILE is not a PEM private key.');
    expect(r.stderr).not.toContain('NOT-A-KEY-CANARY');
    expect(fake?.requests).toEqual([]);
  });

  it('A4. an App ID that is no ID exits 2 without repeating it', async () => {
    const r = await backfillWith({
      GITHUB_APP_ID: '-----BEGIN-ID-CANARY',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile(),
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GITHUB_APP_ID must be an App ID (digits) or a client ID (Iv...).');
    expect(r.stderr).not.toContain('BEGIN-ID-CANARY');
    expect(fake?.requests).toEqual([]);
  });

  it('A4. a GITHUB_TOKEN with a character a header cannot carry exits 2 without quoting it', async () => {
    const r = await backfillWith({ GITHUB_TOKEN: 'ghp_PATCANARY\nx' });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GITHUB_TOKEN has characters a header cannot carry');
    expect(r.stderr).not.toContain('ghp_PATCANARY');
    expect(r.stdout).not.toContain('ghp_PATCANARY');
    expect(fake?.requests).toEqual([]);
  });

  it('A4. an installation id that is not a number exits 2 without repeating it', async () => {
    const r = await backfillWith({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile(),
      GITHUB_APP_INSTALLATION_ID: '12ab',
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('GITHUB_APP_INSTALLATION_ID must be a whole number, like 12345678.');
    expect(r.stderr).not.toContain('12ab');
    expect(fake?.requests).toEqual([]);
  });

  it('A6. a fully set App wins over GITHUB_TOKEN, and stderr names the route', async () => {
    fake = await startFakeGitHub();
    fake.mintReplies.push({ status: 201, token: 'ghs_1', expiresAt: iso(Date.now() + HOUR) });
    const r = await runCliAs(['github', 'backfill', '--repo', REPO], {
      cwd: base,
      env: {
        ...process.env,
        HIPPO_HOME: hippoRoot,
        GITHUB_ENTERPRISE_URL: fake.url,
        GITHUB_APP_ID: '123',
        GITHUB_APP_PRIVATE_KEY_FILE: keyFile(),
        GITHUB_APP_INSTALLATION_ID: '42',
        GITHUB_TOKEN: 'pat-canary',
      },
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('GitHub auth: GitHub App 123 (GITHUB_TOKEN is set and not used)');
    expect(lists(fake)).toHaveLength(3);
    for (const request of fake.requests) expect(request.authorization).not.toContain('pat-canary');
    expect(bearers(lists(fake))).toEqual(Array(3).fill('Bearer ghs_1'));
  });
});
