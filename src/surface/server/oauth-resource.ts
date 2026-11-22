// The OAuth protected-resource metadata and the /mcp 401 challenge, both frozen at boot.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../../base/errors/http-errors.js';
import { isJsonString } from '../../base/util/json.js';
import { parseOutboundUrl } from '../../base/util/net.js';
import { readAuthHeader } from './auth.js';
import type { ServeOptions } from './types.js';

const WELL_KNOWN = '/.well-known/oauth-protected-resource';
// RFC 6749 scope token: printable ASCII but space, quote and backslash.
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const ENCODED_SLASH = /%2f/i;

/** The two `WWW-Authenticate` values a /mcp 401 can carry, built once at boot. */
export interface OAuthChallenge {
  readonly withError: string;
  readonly withoutError: string;
}

/** What boot serves for the oauth setting: the document by path, and the frozen challenge. */
export interface OAuthBoot {
  readonly bodies: ReadonlyMap<string, string>;
  readonly challenge: OAuthChallenge | undefined;
}

function checkOAuthUrl(raw: string, setting: string): URL {
  if (!isJsonString(raw)) throw new Error(`${setting} is not a valid URL`);
  const url = parseOutboundUrl(raw, { setting });
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error(`${setting} must have no query or fragment`);
  }
  return url;
}

function checkResource(raw: string): URL {
  const url = checkOAuthUrl(raw, 'oauth.resource');
  if (!url.pathname.endsWith('/mcp')) {
    throw new Error('oauth.resource must be the public URL of /mcp, so its path ends in /mcp');
  }
  // rejectEncodedSlash would answer 400 at the metadata path built from it.
  if (ENCODED_SLASH.test(url.pathname)) {
    throw new Error('oauth.resource must not encode a slash in its path');
  }
  if (url.href !== raw) throw new Error(`oauth.resource must be written as ${url.href}`);
  return url;
}

function checkAuthorizationServers(list: readonly string[]): void {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('oauth.authorizationServers must list at least one authorization server');
  }
  list.forEach((raw, i) => checkOAuthUrl(raw, `oauth.authorizationServers[${i}]`));
}

function checkScopes(scopes: readonly string[] | undefined): void {
  if (scopes === undefined) return;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('oauth.scopes must list at least one scope when set');
  }
  scopes.forEach((scope, i) => {
    if (!isJsonString(scope) || !SCOPE_TOKEN.test(scope)) {
      throw new Error(`oauth.scopes[${i}] must be one scope token: no space, quote or backslash`);
    }
  });
  if (scopes.includes('offline_access')) {
    throw new Error('oauth.scopes must not ask for offline_access');
  }
}

function metadataPathOf(resource: URL): string {
  return `${WELL_KNOWN}${resource.pathname}`;
}

function challengeOf(resource: URL, scopes: readonly string[] | undefined): OAuthChallenge {
  const parts = [`Bearer resource_metadata="${resource.origin}${metadataPathOf(resource)}"`];
  if (scopes !== undefined) parts.push(`scope="${scopes.join(' ')}"`);
  return {
    withoutError: parts.join(', '),
    withError: [...parts, 'error="invalid_token"'].join(', '),
  };
}

/** Boot-time check of the oauth setting. Returns the document by path and the frozen 401 challenge,
 * both empty when unset. Reads each field once, so a later change to the object has no effect. */
export function oauthBoot(opts: Pick<ServeOptions, 'oauth' | 'authResolver'>): OAuthBoot {
  const { oauth } = opts;
  if (oauth === undefined) return { bodies: new Map(), challenge: undefined };
  if (opts.authResolver === undefined) {
    throw new Error(
      'oauth needs an authResolver to check the tokens its authorization servers issue',
    );
  }
  const { resource: rawResource, authorizationServers, scopes } = oauth;
  const servers = [...(Array.isArray(authorizationServers) ? authorizationServers : [])];
  const copiedScopes =
    scopes === undefined ? undefined : [...(Array.isArray(scopes) ? scopes : [])];
  const url = checkResource(rawResource);
  checkAuthorizationServers(servers);
  checkScopes(copiedScopes);
  const text = JSON.stringify({
    resource: rawResource,
    authorization_servers: servers,
    bearer_methods_supported: ['header'],
    ...(copiedScopes !== undefined && { scopes_supported: copiedScopes }),
  });
  return {
    bodies: new Map([[metadataPathOf(url), text]]),
    challenge: challengeOf(url, copiedScopes),
  };
}

/** Runs a /mcp route's auth check. A 401 leaves with the challenge header when the setting is on. */
export async function withOAuthChallenge<T>(
  req: IncomingMessage,
  res: ServerResponse,
  challenge: OAuthChallenge | undefined,
  check: () => Promise<T>,
): Promise<T> {
  try {
    return await check();
  } catch (err) {
    if (challenge !== undefined && err instanceof HttpError && err.status === 401) {
      const tokenSent = readAuthHeader(req).kind === 'bearer';
      res.setHeader('www-authenticate', tokenSent ? challenge.withError : challenge.withoutError);
    }
    throw err;
  }
}
