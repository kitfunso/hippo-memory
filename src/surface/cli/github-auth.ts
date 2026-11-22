/** Picks the backfill's credential from env: a GitHub App when it is set, else GITHUB_TOKEN. Every
 * setting error is a GitHubAuthSettingError with fixed text, so no value or key text reaches stderr.
 */

import * as fs from 'node:fs';
import type { KeyObject } from 'node:crypto';
import {
  envGitHubAppId,
  envGitHubAppInstallationId,
  envGitHubAppPrivateKeyFile,
  envGitHubToken,
} from '../../base/util/env.js';
import { errorCode, errorMessage } from '../../base/util/log.js';
import { checkHeaderSafe } from '../../base/util/net.js';
import { appTokenSource, parseAppPrivateKey } from '../connectors/github/app-auth.js';
import { staticTokenSource, type GitHubTokenSource } from '../connectors/github/octokit-client.js';
import type { GitHubSite } from '../connectors/github/site.js';

/** A setting the operator can fix; the CLI prints its text and exits 2. */
export class GitHubAuthSettingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthSettingError';
  }
}

// An App ID is digits; a client ID starts Iv. Both are valid JWT `iss` values.
const APP_ID_RE = /^(?:[1-9][0-9]{0,14}|Iv[A-Za-z0-9.]{2,40})$/;
const INSTALLATION_ID_RE = /^[1-9][0-9]*$/;

export interface GitHubAuthInput {
  readonly site: GitHubSite;
  readonly repoFullName: string;
}

export interface GitHubAuth {
  /** What the stderr line names: the credential in use, never its value. */
  readonly route: string;
  readonly source: GitHubTokenSource;
}

interface AppSettings {
  readonly appId: string;
  readonly keyFile: string;
  readonly installationId: string | undefined;
}

/** The App settings, or undefined when none is set; some set without the ID or the key file throws. */
function appSettingsFromEnv(): AppSettings | undefined {
  const appId = envGitHubAppId();
  const keyFile = envGitHubAppPrivateKeyFile();
  const installationId = envGitHubAppInstallationId();
  if (appId === undefined && keyFile === undefined && installationId === undefined) {
    return undefined;
  }
  if (appId === undefined || keyFile === undefined) {
    const missing = appId === undefined ? ['GITHUB_APP_ID'] : [];
    if (keyFile === undefined) missing.push('GITHUB_APP_PRIVATE_KEY_FILE');
    throw new GitHubAuthSettingError(
      `GitHub App settings are incomplete: set ${missing.join(' and ')}, or unset the GITHUB_APP_ variables.`,
    );
  }
  return { appId, keyFile, installationId };
}

function checkAppIds({ appId, installationId }: AppSettings): void {
  if (!APP_ID_RE.test(appId)) {
    throw new GitHubAuthSettingError(
      'GITHUB_APP_ID must be an App ID (digits) or a client ID (Iv...).',
    );
  }
  if (installationId !== undefined && !INSTALLATION_ID_RE.test(installationId)) {
    throw new GitHubAuthSettingError(
      'GITHUB_APP_INSTALLATION_ID must be a whole number, like 12345678.',
    );
  }
}

/** Reads and parses the key before the backfill starts, so a bad file exits 2 and not mid-run. */
function readAppKey(file: string): KeyObject {
  let pem: string;
  try {
    pem = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = errorCode(err) || 'unknown';
    throw new GitHubAuthSettingError(`GITHUB_APP_PRIVATE_KEY_FILE cannot be read (${code}).`);
  }
  try {
    return parseAppPrivateKey(pem);
  } catch (err) {
    throw new GitHubAuthSettingError(errorMessage(err));
  }
}

// fetch quotes a header value it rejects, so a token with such a character must not get that far.
function checkPat(pat: string): void {
  try {
    checkHeaderSafe('GITHUB_TOKEN', pat);
  } catch (err) {
    throw new GitHubAuthSettingError(errorMessage(err));
  }
}

/** A fully set App wins over GITHUB_TOKEN, which developers keep in env for other tools. */
export function githubAuthFromEnv({ site, repoFullName }: GitHubAuthInput): GitHubAuth {
  const app = appSettingsFromEnv();
  const pat = envGitHubToken();
  if (app === undefined) {
    if (!pat) {
      throw new GitHubAuthSettingError(
        'GITHUB_TOKEN is not set. Backfill requires a personal access token with repo read scope, ' +
          'or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE for a GitHub App.',
      );
    }
    checkPat(pat);
    return { route: 'GITHUB_TOKEN', source: staticTokenSource(pat) };
  }
  checkAppIds(app);
  const privateKey = readAppKey(app.keyFile);
  const { appId, installationId } = app;
  const source = appTokenSource({ appId, privateKey, installationId, site, repoFullName });
  const unused = pat ? ' (GITHUB_TOKEN is set and not used)' : '';
  return { route: `GitHub App ${appId}${unused}`, source };
}
