// Where the agent tools keep their config and data, shared by the hook installers and the agent-memory readers.

import * as os from 'os';
import * as path from 'path';
import { envHomeDir, processEnv } from './env.js';

type Env = Readonly<Record<string, string | undefined>>;

const VSCODE_PRODUCTS = ['Code', 'Code - Insiders'] as const;

export function homeDir(): string {
  return envHomeDir() || os.homedir();
}

/** Codex's config folder: $CODEX_HOME, else ~/.codex, as the Codex hooks docs describe. */
export function codexHomeDir(home: string = homeDir(), env: Env = processEnv()): string {
  return env.CODEX_HOME || path.join(home, '.codex');
}

/** Claude Code's config folder, where it reads settings.json: $CLAUDE_CONFIG_DIR when set and non-empty, else
 * ~/.claude under os.homedir(), as Claude Code does (a HOME that differs from the profile must not move it). */
export function claudeConfigDir(home: string = os.homedir(), env: Env = processEnv()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** VS Code's user-data resolution: portable install first, then the app-data override, then the platform default. */
export function vscodeDataFolders(ctx: { readonly env: Env; readonly home: string; readonly platform: NodeJS.Platform }): string[] {
  const { env, home, platform } = ctx;
  if (env.VSCODE_PORTABLE) return [path.join(env.VSCODE_PORTABLE, 'user-data')];
  let appData: string;
  if (env.VSCODE_APPDATA) appData = env.VSCODE_APPDATA;
  else if (platform === 'win32') appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') appData = path.join(home, 'Library', 'Application Support');
  else appData = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return VSCODE_PRODUCTS.map((product) => path.join(appData, product));
}
