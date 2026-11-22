/** Which GitHub server the connector talks to: github.com, or the GHES server GITHUB_ENTERPRISE_URL
 * names; and the host check the webhook and the DLQ replay share. */

import { isJsonObject, type JsonValue } from '../../../base/util/json.js';
import { parseOutboundUrl, tryParseUrl } from '../../../base/util/net.js';

export interface GitHubSite {
  /** The GHES host name that refs, repo: tags, scopes and cursors carry; undefined on github.com. */
  readonly host: string | undefined;
  /** Where every backfill URL starts. */
  readonly apiBase: string;
  /** True only when the operator set GITHUB_ENTERPRISE_BARE_REFS_HOST to this host: a ref with no
   * host is then a row this server stored before the setting existed. */
  readonly ownsBareRefs: boolean;
}

export const GITHUB_COM: GitHubSite = {
  host: undefined,
  apiBase: 'https://api.github.com',
  ownsBareRefs: false,
};

/** The origin a person opens in a browser: the links in a lesson are built from it. */
export function githubWebOrigin(site: GitHubSite): string {
  return site.host === undefined ? 'https://github.com' : new URL(site.apiBase).origin;
}

const SETTING = 'GITHUB_ENTERPRISE_URL';
const BARE_SETTING = 'GITHUB_ENTERPRISE_BARE_REFS_HOST';

/** The site a GITHUB_ENTERPRISE_URL value names; unset is github.com. `bareRefsHost` is the
 * GITHUB_ENTERPRISE_BARE_REFS_HOST value. Throws, naming the setting, on a value that is not a
 * GHES root URL or a bare-refs host that is not this server. */
export function parseGitHubEnterpriseUrl(
  raw: string | undefined,
  bareRefsHost?: string,
): GitHubSite {
  if (raw === undefined) {
    if (bareRefsHost !== undefined) {
      throw new Error(`${BARE_SETTING} needs ${SETTING}, which names the same host`);
    }
    return GITHUB_COM;
  }
  const url = parseOutboundUrl(raw, { setting: SETTING, keySetting: 'GITHUB_TOKEN' });
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `${SETTING} must be the server's root URL, like https://ghes.example.com; hippo adds /api/v3`,
    );
  }
  const host = url.hostname;
  if (host.endsWith('.')) throw new Error(`${SETTING} must not end its host name with a dot`);
  // An owner login never holds a dot or a colon, so a ref cannot read this host as an owner.
  if (!/[.:]/.test(host)) {
    throw new Error(`${SETTING} needs a dotted host name, like https://ghes.example.com`);
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    throw new Error(`${SETTING} names github.com; unset it to use github.com`);
  }
  if (bareRefsHost !== undefined && bareRefsHost.trim().toLowerCase() !== host) {
    throw new Error(`${BARE_SETTING} is ${bareRefsHost}, but ${SETTING} names ${host}`);
  }
  return { host, apiBase: `${url.origin}/api/v3`, ownsBareRefs: bareRefsHost !== undefined };
}

const MISMATCH = 'host_mismatch: X-GitHub-Enterprise-Host=';
const HOST_TOKEN = /^[a-z0-9.:[\]-]+$/;

/** X-GitHub-Enterprise-Host as a host name: undefined when absent or blank, '(invalid)' when it
 * is not a plain host, so the park error stays readable. */
export function headerHost(raw: string | null): string | undefined {
  const host = raw?.trim().toLowerCase();
  if (!host) return undefined;
  return HOST_TOKEN.test(host) ? host : '(invalid)';
}

/** The park error for a delivery `sent` by another server (undefined is github.com), or null when
 * the site takes it. An unset setting takes any server, as before GHES support. */
export function hostMismatch(sent: string | undefined, site: GitHubSite): string | null {
  if (site.host === undefined || sent === site.host) return null;
  return `${MISMATCH}${sent ?? '(none)'}; ${SETTING} names ${site.host}`;
}

/** The sender a hostMismatch error records (undefined for github.com); null for any other text. */
export function mismatchSender(error: string): { readonly sent: string | undefined } | null {
  if (!error.startsWith(MISMATCH)) return null;
  const sent = error.slice(MISMATCH.length).split(';', 1)[0];
  return { sent: sent === '(none)' ? undefined : sent };
}

function isText(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

/** The lowercase host of a parsed payload's repository.html_url, the signed statement of which
 * server sent it; undefined when absent or not a URL. */
export function payloadHost(payload: JsonValue | undefined): string | undefined {
  if (!isJsonObject(payload) || !isJsonObject(payload.repository)) return undefined;
  const htmlUrl = payload.repository.html_url;
  return isText(htmlUrl) ? tryParseUrl(htmlUrl)?.hostname.toLowerCase() : undefined;
}

/** The park error for a payload from a server the site does not take, in the header-error form so
 * a replay reads the header value from it; null when the site takes the payload. */
export function payloadMismatch(
  sent: string | undefined,
  host: string | undefined,
  site: GitHubSite,
): string | null {
  const refusal = payloadHostRefusal(host, site);
  return refusal === null ? null : `${MISMATCH}${sent ?? '(none)'}; ${refusal}`;
}

/** Why a payload that names `host` (undefined: no repository URL) may not be stored under this
 * site, or null when it may. An unset GITHUB_ENTERPRISE_URL takes any server. */
export function payloadHostRefusal(host: string | undefined, site: GitHubSite): string | null {
  if (site.host === undefined || host === site.host) return null;
  return `payload names ${host ?? 'no repository URL'}; ${SETTING} names ${site.host}`;
}
