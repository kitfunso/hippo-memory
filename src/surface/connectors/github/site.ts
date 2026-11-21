/** Which GitHub server the connector talks to: github.com, or the GHES server GITHUB_ENTERPRISE_URL
 * names; and the host check the webhook and the DLQ replay share. */

import { parseOutboundUrl } from '../../../base/util/net.js';

export interface GitHubSite {
  /** The GHES host name that refs, repo: tags, scopes and cursors carry; undefined on github.com. */
  readonly host: string | undefined;
  /** Where every backfill URL starts. */
  readonly apiBase: string;
}

export const GITHUB_COM: GitHubSite = { host: undefined, apiBase: 'https://api.github.com' };

const SETTING = 'GITHUB_ENTERPRISE_URL';

/** The site a GITHUB_ENTERPRISE_URL value names; unset is github.com. Throws, naming the setting,
 * on a value that is not a GHES root URL. */
export function parseGitHubEnterpriseUrl(raw: string | undefined): GitHubSite {
  if (raw === undefined) return GITHUB_COM;
  const url = parseOutboundUrl(raw, { setting: SETTING, keySetting: 'GITHUB_TOKEN' });
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(
      `${SETTING} must be the server's root URL, like https://ghes.example.com; hippo adds /api/v3`,
    );
  }
  const host = url.hostname;
  // An owner login never holds a dot or a colon, so a ref cannot read this host as an owner.
  if (!/[.:]/.test(host)) {
    throw new Error(`${SETTING} needs a dotted host name, like https://ghes.example.com`);
  }
  if (host === 'github.com' || host.endsWith('.github.com')) {
    throw new Error(`${SETTING} names github.com; unset it to use github.com`);
  }
  return { host, apiBase: `${url.origin}/api/v3` };
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
