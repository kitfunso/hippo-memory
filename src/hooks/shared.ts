import { envHomeDir, processEnv } from '../env.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vscodeDataFolders } from '../agent-memories/copilot.js';

export type JsonHookTarget = 'claude-code' | 'codex' | 'copilot';

export interface ToolDetection {
  name: string;
  configDir: string;
  detected: boolean;
  kind: 'json-hook' | 'markdown-instruction' | 'plugin' | 'wrapper';
  notes?: string;
}

export const HIPPO_SLEEP_MARKER = 'hippo sleep';
export const HIPPO_LAST_SLEEP_MARKER = 'hippo last-sleep';
export const HIPPO_CAPTURE_MARKER = 'hippo capture --last-session';
export const HIPPO_SESSION_END_MARKER = 'hippo session-end';
export const HIPPO_PINNED_INJECT_MARKER = 'hippo context --pinned-only';
export const HIPPO_PINNED_INJECT_COMMAND = 'hippo context --pinned-only --include-recent 5 --format additional-context';
export const HIPPO_CODEX_WRAPPER_MARKER = 'hippo codex wrapper';
export const HIPPO_PRE_COMPACT_MARKER = 'hippo pre-compact';
export const HIPPO_COMPACT_RESUME_MARKER = 'hippo compact-resume';
export const HIPPO_CAPTURE_ERROR_MARKER = 'hippo capture-error';
export const HIPPO_POST_COMPACT_MARKER = 'hippo post-compact';

export function homeDir(): string {
  return envHomeDir() || os.homedir();
}

/** Codex's config folder: $CODEX_HOME, else ~/.codex, as the Codex hooks docs describe. */
export function codexHomeDir(home: string = homeDir(), env: Readonly<Record<string, string | undefined>> = processEnv()): string {
  return env.CODEX_HOME || path.join(home, '.codex');
}

/** Copilot's config folder: $COPILOT_HOME, else ~/.copilot under os.homedir(), as the Copilot apps resolve it (a HOME that differs from the profile must not move it). */
export function copilotHomeDir(home: string = os.homedir(), env: Readonly<Record<string, string | undefined>> = processEnv()): string {
  return env.COPILOT_HOME || path.join(home, '.copilot');
}

/** Claude Code's config folder, where it reads settings.json: $CLAUDE_CONFIG_DIR when set and non-empty, else ~/.claude under os.homedir(), as Claude Code does (a HOME that differs from the profile must not move it). */
export function claudeConfigDir(home: string = os.homedir(), env: Readonly<Record<string, string | undefined>> = processEnv()): string {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** Codex counts as installed only when its config folder exists: Codex itself refuses a CODEX_HOME that is not a folder. */
export function isCodexPresent(home: string = homeDir()): boolean {
  return fs.statSync(codexHomeDir(home), { throwIfNoEntry: false })?.isDirectory() === true;
}

/** hippo's own hooks file, in the hooks folder the Copilot CLI reads. */
export function copilotHooksFile(): string {
  return path.join(copilotHomeDir(), 'hooks', 'hippo.json');
}

/** Where VS Code's agent finds hippo.json: its docs name ~/.copilot/hooks as the user hooks folder, whatever COPILOT_HOME says. */
export function vscodeUserHooksFile(home: string = os.homedir()): string {
  return path.join(home, '.copilot', 'hooks', 'hippo.json');
}

/** The VS Code User folders that exist; Stable and Insiders keep their own, and only an edition the user has run has one. */
export function vscodeUserDirs(env: Readonly<Record<string, string | undefined>> = processEnv(), home: string = os.homedir()): string[] {
  return vscodeDataFolders({ env, home, platform: process.platform })
    .map((dir) => path.join(dir, 'User'))
    .filter((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);
}

/** Copilot counts as installed only when its config folder or a VS Code User folder exists, so setup never creates ~/.copilot on a machine with neither. */
export function isCopilotPresent(home: string = os.homedir()): boolean {
  return fs.statSync(copilotHomeDir(home), { throwIfNoEntry: false })?.isDirectory() === true || vscodeUserDirs(processEnv(), home).length > 0;
}

/** Codex hashes each hook and skips new or changed ones until the user reviews them in `/hooks`, so the reminder says what they would trust. */
export const CODEX_TRUST_LINE = "The per-prompt hook sends your pinned memories plus up to 5 that match the prompt. Codex runs hippo's hooks only after you trust them once in `/hooks`.";

/**
 * Default log path consumed by `hippo last-sleep`. Shared fallback when
 * a caller doesn't pass --path explicitly.
 */
export function defaultSleepLogPath(): string {
  return path.join(homeDir(), '.hippo', 'logs', 'last-sleep.log');
}

/**
 * Diagnostic-only log path for `hippo pre-compact`. Deliberately separate
 * from the SessionEnd sleep log: `hippo last-sleep` truncates that file on
 * every SessionStart, which would wipe pre-compact lines before anyone
 * could read them. Nothing consumes this file programmatically — it exists
 * for manual troubleshooting only. Overridden by `--log-file`.
 */
export function defaultPreCompactLogPath(): string {
  return path.join(homeDir(), '.hippo', 'logs', 'pre-compact.log');
}

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Detect which AI coding tools are installed based on config directory presence.
 * Used by `hippo setup` to decide which JSON-hook installs to run.
 */
export function detectInstalledTools(): ToolDetection[] {
  const home = homeDir();
  const exists = (...parts: string[]) => fs.existsSync(path.join(home, ...parts));
  const claudeDir = claudeConfigDir();
  return [
    { name: 'claude-code', configDir: claudeDir, detected: fs.existsSync(claudeDir), kind: 'json-hook' },
    { name: 'opencode', configDir: '~/.config/opencode', detected: exists('.config', 'opencode'), kind: 'plugin', notes: 'installs a TS plugin at ~/.config/opencode/plugins/hippo.ts' },
    { name: 'openclaw', configDir: '~/.openclaw', detected: exists('.openclaw'), kind: 'plugin', notes: 'install via `openclaw plugins install hippo-memory`' },
    { name: 'codex', configDir: '~/.codex', detected: isCodexPresent(home), kind: 'wrapper', notes: 'memory hooks in hooks.json, and wraps the detected codex launcher for session-end consolidation' },
    { name: 'copilot', configDir: copilotHomeDir(), detected: isCopilotPresent(), kind: 'json-hook', notes: 'hooks in hooks/hippo.json, the MCP server in mcp-config.json and a block in copilot-instructions.md; for VS Code, the server in each User mcp.json and prompts/hippo.instructions.md' },
    { name: 'cursor', configDir: '~/.cursor', detected: exists('.cursor'), kind: 'markdown-instruction', notes: 'no hook API - patches AGENTS.md in the project' },
    { name: 'pi', configDir: '~/.pi', detected: exists('.pi'), kind: 'markdown-instruction', notes: 'no hook API - patches AGENTS.md in the project' },
  ];
}
