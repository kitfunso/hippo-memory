import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../../base/errors/http-errors.js';
import { isCallable, isObjectLike } from '../../base/session/capture-contract.js';
import { isJsonString } from '../../base/util/json.js';
import { parseOutboundUrl } from '../../base/util/net.js';
import { readAuthHeader } from './auth.js';
import type { OAuthChallenge, ServeOptions } from './types.js';

const WELL_KNOWN = '/.well-known/oauth-protected-resource';
// RFC 6749 scope token: printable ASCII but space, quote and backslash.
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const ENCODED_SLASH = /%2f/i;
const ISSUER_TEXT = /^[\x21-\x7e]+$/;

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
  if (ENCODED_SLASH.test(url.pathname)) {
    throw new Error('oauth.resource must not encode a slash in its path');
  }
  if (url.href !== raw) throw new Error(`oauth.resource must be written as ${url.href}`);
  return url;
}

function checkIssuer(raw: string, i: number): void {
  const setting = `oauth.authorizationServers[${i}]`;
  const url = checkOAuthUrl(raw, setting);
  if (!ISSUER_TEXT.test(raw)) {
    throw new Error(`${setting} must be printable ASCII only, with no space or control character`);
  }
  // A path-less issuer serialises with a slash, yet the issuer is the string as its server wrote it.
  if (url.href !== raw && url.href !== `${raw}/`) {
    const expected = url.pathname === '/' && !raw.endsWith('/') ? url.href.slice(0, -1) : url.href;
    throw new Error(`${setting} must be written as ${expected}, in normal URL form`);
  }
}

function checkAuthorizationServers(list: readonly string[]): readonly string[] {
  if (!Array.isArray(list)) {
    throw new Error('oauth.authorizationServers must be an array of strings');
  }
  const servers = [...list];
  if (servers.length === 0) {
    throw new Error('oauth.authorizationServers must list at least one authorization server');
  }
  servers.forEach(checkIssuer);
  return servers;
}

function checkScopes(scopes: readonly string[] | undefined): readonly string[] | undefined {
  if (scopes === undefined) return undefined;
  if (!Array.isArray(scopes)) throw new Error('oauth.scopes must be an array of strings');
  const copy = [...scopes];
  if (copy.length === 0) throw new Error('oauth.scopes must list at least one scope when set');
  copy.forEach((scope, i) => {
    if (!isJsonString(scope) || !SCOPE_TOKEN.test(scope)) {
      throw new Error(`oauth.scopes[${i}] must be one scope token: no space, quote or backslash`);
    }
  });
  if (copy.includes('offline_access')) {
    throw new Error('oauth.scopes must not ask for offline_access');
  }
  return copy;
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
  if (!isObjectLike(oauth)) {
    throw new Error('oauth must be an object with resource and authorizationServers');
  }
  if (!isCallable(opts.authResolver)) {
    throw new Error(
      'oauth needs an authResolver to check the tokens its authorization servers issue',
    );
  }
  const { resource: rawResource, authorizationServers, scopes } = oauth;
  const url = checkResource(rawResource);
  const servers = checkAuthorizationServers(authorizationServers);
  const copiedScopes = checkScopes(scopes);
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
