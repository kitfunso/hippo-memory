// Where hippo and the agent tools keep their config and data, from a machine's home folder and environment: the rules
// only. src/host/agent-homes.ts reads this process's home, and src/infra/machine.ts builds the real Machine.

import * as path from 'path';
import type { AgentFiles } from './agent-files.js';
import type { GitRunner } from '../ports/git.js';
import type { ProjectIdentity } from '../scope/project-identity.js';

/** The folder a hippo store lives in: `<project>/.hippo`, and `~/.hippo` for the global one. */
export const HIPPO_DIR = '.hippo';

type Env = Readonly<Record<string, string | undefined>>;

/** Everything the agent-memory adapters and the hook installers may know about the machine, its disk and git included;
 * src/infra/machine.ts builds the real one and tests hand in a scratch one. */
export interface Machine {
  readonly home: string;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
  readonly files: AgentFiles;
  readonly git: GitRunner;
  /** The folder the process runs in, whose path segments boost a recall; absent, no path boost. */
  readonly cwd?: string;
  /** The project a folder belongs to, as src/host walks its markers. */
  readonly projectIdentity: (dir: string) => ProjectIdentity;
  /** hippo's global store folder, read when asked so a changed HIPPO_HOME shows. */
  readonly globalRoot: () => string;
  /** Whether a folder is the global store's, links and case resolved as the disk has them. */
  readonly isGlobalRoot: (hippoRoot: string) => boolean;
}

/** The home folder and environment the path rules below read. */
export type Homes = Pick<Machine, 'home' | 'env'>;

/** The home a HOME or USERPROFILE variable names, else the profile's; codex, opencode and hippo's logs live there. */
export function userHome({ home, env }: Homes): string {
  return env.HOME || env.USERPROFILE || home;
}

/** Whether CLAUDE_CONFIG_DIR or a home variable says where Claude Code's files are. */
export function claudeHomeIsSet(env: Env): boolean {
  return Boolean(env.CLAUDE_CONFIG_DIR || env.HOME || env.USERPROFILE);
}

const VSCODE_PRODUCTS = ['Code', 'Code - Insiders'] as const;

/** Codex's config folder: $CODEX_HOME, else ~/.codex, as the Codex hooks docs describe. */
export function codexHomeDir(home: string, env: Env): string {
  return env.CODEX_HOME || path.join(home, '.codex');
}

/** Claude Code's config folder, where it reads settings.json: $CLAUDE_CONFIG_DIR when set and non-empty, else ~/.claude
 * under os.homedir(), as Claude Code does (a HOME that differs from the profile must not move it). */
export function claudeConfigDir(home: string, env: Env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** VS Code's user-data resolution: portable install first, then the app-data override, then the platform default. */
export function vscodeDataFolders(ctx: {
  readonly env: Env;
  readonly home: string;
  readonly platform: NodeJS.Platform;
}): string[] {
  const { env, home, platform } = ctx;
  if (env.VSCODE_PORTABLE) return [path.join(env.VSCODE_PORTABLE, 'user-data')];
  let appData: string;
  if (env.VSCODE_APPDATA) appData = env.VSCODE_APPDATA;
  else if (platform === 'win32') appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  else if (platform === 'darwin') appData = path.join(home, 'Library', 'Application Support');
  else appData = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return VSCODE_PRODUCTS.map((product) => path.join(appData, product));
}
