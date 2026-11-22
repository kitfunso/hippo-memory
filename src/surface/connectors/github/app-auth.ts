/** GitHub App auth for the backfill: signs the App JWT and trades it for installation tokens, which
 * live one hour. It never reads env, and no key, JWT, token or reply body reaches an error or a log.
 */

import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { hostAndPath, GITHUB_TIMEOUT_MS, type GitHubTokenSource } from './octokit-client.js';
import type { GitHubSite } from './site.js';
import { fetchWithRetry } from '../../../infra/http-retry.js';
import { readCappedJson } from '../../../base/util/capped-json.js';
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonValue,
} from '../../../base/util/json.js';
import { errorClassFields, errorFields, errorMessage, log } from '../../../base/util/log.js';
import { MINUTE_MS } from '../../../base/util/time.js';

// A token is replaced this long before it ends, so a request in flight never meets its expiry.
const REMINT_MARGIN_MS = 5 * MINUTE_MS;
const MAX_TOKEN_TTL_MS = 60 * MINUTE_MS;
const MAX_REPLY_BYTES = 1024 * 1024;
// GitHub refuses a JWT that starts in its future or lives past 10 minutes.
const JWT_BACKDATE_S = 60;
const JWT_LIFETIME_S = 540;
const INSTALLATION_HINT =
  "; set GITHUB_APP_INSTALLATION_ID, use the repository's current name, " +
  'or check that the App is installed on it.';
const UNAUTHORIZED_HINT = "; check GITHUB_APP_ID, the key file and this machine's clock.";
// The token goes into an Authorization header, so a reply with any other character is broken.
const HEADER_SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;

/** The key as a node KeyObject; the parser's own error can quote what it read, so it is dropped. */
export function parseAppPrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY_FILE is not a PEM private key.');
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY_FILE is not an RSA private key; GitHub App keys are RSA.',
    );
  }
  return key;
}

const base64url = (input: string): string => Buffer.from(input).toString('base64url');

export interface AppJwtInput {
  readonly appId: string;
  readonly privateKey: KeyObject;
  readonly nowMs: number;
}

/** An RS256 JWT for the App; an all-digit id goes in as a number, a client id as text. */
export function signAppJwt({ appId, privateKey, nowMs }: AppJwtInput): string {
  const nowS = Math.floor(nowMs / 1000);
  const iss = /^[0-9]+$/.test(appId) ? Number(appId) : appId;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = { iat: nowS - JWT_BACKDATE_S, exp: nowS + JWT_LIFETIME_S, iss };
  const payload = base64url(JSON.stringify(claims));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

export function installationTokenUrl(site: GitHubSite, installationId: string): string {
  return `${site.apiBase}/app/installations/${installationId}/access_tokens`;
}

export function repoInstallationUrl(site: GitHubSite, repoFullName: string): string {
  return `${site.apiBase}/repos/${repoFullName}/installation`;
}

const tokenRequestAt = (url: string): string => `GitHub App token request to ${hostAndPath(url)}`;
const lookupAt = (url: string): string => `GitHub App installation lookup at ${hostAndPath(url)}`;

// No redirect is followed: the JWT can mint tokens for every installation, so it goes to one host.
async function appRequest(
  url: string,
  jwt: string,
  where: string,
  body?: string,
): Promise<Response> {
  const headers = new Headers({
    Authorization: `Bearer ${jwt}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  });
  // fetch sends a string body as text/plain.
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return fetchWithRetry(
    url,
    { method: body === undefined ? 'GET' : 'POST', headers, body, redirect: 'manual' },
    // A replayed mint only creates another short-lived token.
    { timeoutMs: GITHUB_TIMEOUT_MS, retryTransport: true },
  ).catch((err) => {
    throw new Error(`${where} failed: ${errorMessage(err)}`, { cause: err });
  });
}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch (err) {
    log.debug(
      `github app: could not cancel the reply body: ${errorMessage(err)}`,
      errorFields(err),
    );
  }
}

async function readJsonReply(res: Response, failure: string): Promise<JsonValue> {
  try {
    return await readCappedJson(res, MAX_REPLY_BYTES);
  } catch (err) {
    // capped-json's text is fixed (over the cap, or not JSON), so it names the cause, not the body.
    log.debug(`GitHub App reply unreadable: ${errorMessage(err)}`, errorClassFields(err));
    throw new Error(failure);
  }
}

function mintHint(status: number): string {
  if (status === 401) return UNAUTHORIZED_HINT;
  return status === 404 || status === 422 ? INSTALLATION_HINT : '';
}

/** The installation id of the App on this repository, as digits. */
async function lookupInstallation(
  site: GitHubSite,
  repoFullName: string,
  jwt: string,
): Promise<string> {
  const url = repoInstallationUrl(site, repoFullName);
  const res = await appRequest(url, jwt, lookupAt(url));
  if (res.status !== 200) {
    await cancelBody(res);
    const hint = res.status === 401 ? UNAUTHORIZED_HINT : INSTALLATION_HINT;
    throw new Error(`${lookupAt(url)} failed: HTTP ${res.status}${hint}`);
  }
  const failure = `GitHub App installation reply from ${hostAndPath(url)} has no installation id`;
  const body = await readJsonReply(res, failure);
  const id = isJsonObject(body) ? body.id : undefined;
  if (!isJsonNumber(id) || !Number.isSafeInteger(id) || id <= 0) throw new Error(failure);
  return String(id);
}

interface MintedToken {
  readonly token: string;
  readonly ttlMs: number;
}

// The ttl counts from before the request left, so a slow reply or a clock behind GitHub's only
// shortens it; a reply with no usable expiry is broken.
async function readMintReply(
  res: Response,
  url: string,
  wallAtMintStart: number,
): Promise<MintedToken> {
  const failure = `GitHub App token reply from ${hostAndPath(url)} has no token or expiry`;
  const body = await readJsonReply(res, failure);
  const token = isJsonObject(body) ? body.token : undefined;
  const expiresAt = isJsonObject(body) ? body.expires_at : undefined;
  if (!isJsonString(token) || !HEADER_SAFE_TOKEN.test(token) || !isJsonString(expiresAt)) {
    throw new Error(failure);
  }
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) throw new Error(failure);
  const ttlMs = Math.min(expiresMs - wallAtMintStart, MAX_TOKEN_TTL_MS);
  if (ttlMs <= 0) throw new Error(failure);
  return { token, ttlMs };
}

/** One installation token for one repository; only a 201 is a token. */
async function mintInstallationToken(
  site: GitHubSite,
  installationId: string,
  repoName: string,
  jwt: string,
  wallAtMintStart: number,
): Promise<MintedToken> {
  const url = installationTokenUrl(site, installationId);
  const body = JSON.stringify({ repositories: [repoName] });
  const res = await appRequest(url, jwt, tokenRequestAt(url), body);
  if (res.status !== 201) {
    await cancelBody(res);
    throw new Error(`${tokenRequestAt(url)} failed: HTTP ${res.status}${mintHint(res.status)}`);
  }
  return readMintReply(res, url, wallAtMintStart);
}

export interface AppTokenSourceOptions {
  readonly appId: string;
  readonly privateKey: KeyObject;
  /** Looked up once for the repository when absent. */
  readonly installationId?: string;
  readonly site: GitHubSite;
  readonly repoFullName: string;
  /** Wall clock in ms; tests inject it. */
  readonly wall?: () => number;
  /** Monotonic clock in ms; tests inject it. */
  readonly mono?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly deadlineMono: number;
  readonly deadlineWall: number;
}

// Two deadlines: the monotonic one survives a wall clock that jumps back, the wall one counts
// the time a sleeping machine did not.
export function appTokenSource(opts: AppTokenSourceOptions): GitHubTokenSource {
  const { appId, privateKey, site, repoFullName } = opts;
  const wall = opts.wall ?? Date.now;
  const mono = opts.mono ?? (() => performance.now());
  const repoName = repoFullName.slice(repoFullName.indexOf('/') + 1);
  let installationId = opts.installationId;
  let cached: CachedToken | undefined;
  return async () => {
    if (
      cached !== undefined &&
      Math.min(cached.deadlineMono - mono(), cached.deadlineWall - wall()) > REMINT_MARGIN_MS
    ) {
      return cached.token;
    }
    const wallAtMintStart = wall();
    const monoAtMintStart = mono();
    const jwt = signAppJwt({ appId, privateKey, nowMs: wallAtMintStart });
    installationId ??= await lookupInstallation(site, repoFullName, jwt);
    const minted = await mintInstallationToken(
      site,
      installationId,
      repoName,
      jwt,
      wallAtMintStart,
    );
    const { token, ttlMs } = minted;
    cached = {
      token,
      deadlineMono: monoAtMintStart + ttlMs,
      deadlineWall: wallAtMintStart + ttlMs,
    };
    return token;
  };
}
