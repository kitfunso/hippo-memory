/**
 * JSON-hook install/uninstall for AI coding tools.
 *
 * Currently supports Claude Code and OpenCode, which share the same
 * SessionStart/SessionEnd schema. Hippo installs three entries:
 *   - SessionEnd: `hippo sleep --log-file <path>` - captures consolidation
 *     output to a log file because the TUI is tearing down at that point.
 *   - SessionEnd: `hippo capture --last-session` - extracts actionable
 *     memories from the session transcript (one capture per session, not per
 *     turn). The SessionEnd payload stdin carries `transcript_path`, which
 *     `hippo capture` resolves automatically.
 *   - SessionStart: `hippo last-sleep --path <path>` - prints that log on
 *     the next startup and clears it, so the user actually sees it.
 *
 * Legacy entries from versions < 0.21.0 (bare `hippo sleep` in SessionEnd, or
 * the old `Stop` entry from < 0.20.2) are detected and migrated automatically.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type JsonHookTarget = 'claude-code' | 'opencode';

export interface JsonHookPaths {
  settings: string;
  logFile: string;
  display: string;
}

export interface InstallResult {
  target: JsonHookTarget;
  settingsPath: string;
  installedSessionEnd: boolean;
  installedSessionStart: boolean;
  installedSessionCapture: boolean;
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
}

export interface ToolDetection {
  name: string;
  configDir: string;
  detected: boolean;
  kind: 'json-hook' | 'markdown-instruction' | 'plugin';
  notes?: string;
}

const HIPPO_SLEEP_MARKER = 'hippo sleep';
const HIPPO_LAST_SLEEP_MARKER = 'hippo last-sleep';
const HIPPO_CAPTURE_MARKER = 'hippo capture --last-session';
const CURRENT_SESSIONEND_MARKER = 'hippo sleep --log-file';

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/**
 * Default log path consumed by `hippo last-sleep`. Shared fallback when
 * a caller doesn't pass --path explicitly.
 */
export function defaultSleepLogPath(): string {
  return path.join(homeDir(), '.hippo', 'logs', 'last-sleep.log');
}

export function resolveJsonHookPaths(target: JsonHookTarget): JsonHookPaths {
  const home = homeDir();
  const logsDir = path.join(home, '.hippo', 'logs');
  switch (target) {
    case 'claude-code':
      return {
        settings: path.join(home, '.claude', 'settings.json'),
        logFile: path.join(logsDir, 'claude-code-sleep.log'),
        display: 'Claude Code',
      };
    case 'opencode':
      return {
        settings: path.join(home, '.config', 'opencode', 'opencode.json'),
        logFile: path.join(logsDir, 'opencode-sleep.log'),
        display: 'OpenCode',
      };
  }
}

function hookArrayContains(hookArray: unknown, marker: string): boolean {
  if (!Array.isArray(hookArray)) return false;
  return JSON.stringify(hookArray).includes(marker);
}

function hasCurrentFormatSessionEnd(hookArray: unknown): boolean {
  return hookArrayContains(hookArray, CURRENT_SESSIONEND_MARKER);
}

export function installJsonHooks(target: JsonHookTarget): InstallResult {
  const { settings: settingsPath, logFile } = resolveJsonHookPaths(target);
  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      return {
        target,
        settingsPath,
        installedSessionEnd: false,
        installedSessionStart: false,
        installedSessionCapture: false,
        migratedFromStop: false,
        migratedLegacySessionEnd: false,
      };
    }
  }

  if (!settings.hooks) settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  let migratedFromStop = false;
  if (Array.isArray(hooks.Stop) && hookArrayContains(hooks.Stop, HIPPO_SLEEP_MARKER)) {
    hooks.Stop = hooks.Stop.filter((entry) => !JSON.stringify(entry).includes(HIPPO_SLEEP_MARKER));
    if (hooks.Stop.length === 0) delete hooks.Stop;
    migratedFromStop = true;
  }

  let migratedLegacySessionEnd = false;
  if (
    Array.isArray(hooks.SessionEnd) &&
    hookArrayContains(hooks.SessionEnd, HIPPO_SLEEP_MARKER) &&
    !hasCurrentFormatSessionEnd(hooks.SessionEnd)
  ) {
    hooks.SessionEnd = hooks.SessionEnd.filter(
      (entry) => !JSON.stringify(entry).includes(HIPPO_SLEEP_MARKER),
    );
    if (hooks.SessionEnd.length === 0) delete hooks.SessionEnd;
    migratedLegacySessionEnd = true;
  }

  let installedSessionEnd = false;
  if (!hasCurrentFormatSessionEnd(hooks.SessionEnd)) {
    if (!Array.isArray(hooks.SessionEnd)) hooks.SessionEnd = [];
    hooks.SessionEnd.push({
      hooks: [
        {
          type: 'command',
          command: `hippo sleep --log-file "${logFile}"`,
          timeout: 60,
        },
      ],
    });
    installedSessionEnd = true;
  }

  let installedSessionStart = false;
  if (!hookArrayContains(hooks.SessionStart, HIPPO_LAST_SLEEP_MARKER)) {
    if (!Array.isArray(hooks.SessionStart)) hooks.SessionStart = [];
    hooks.SessionStart.push({
      hooks: [
        {
          type: 'command',
          command: `hippo last-sleep --path "${logFile}"`,
          timeout: 5,
        },
      ],
    });
    installedSessionStart = true;
  }

  let installedSessionCapture = false;
  if (!hookArrayContains(hooks.SessionEnd, HIPPO_CAPTURE_MARKER)) {
    if (!Array.isArray(hooks.SessionEnd)) hooks.SessionEnd = [];
    hooks.SessionEnd.push({
      hooks: [
        {
          type: 'command',
          command: 'hippo capture --last-session',
          timeout: 15,
        },
      ],
    });
    installedSessionCapture = true;
  }

  if (
    installedSessionEnd ||
    installedSessionStart ||
    installedSessionCapture ||
    migratedFromStop ||
    migratedLegacySessionEnd
  ) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }

  return {
    target,
    settingsPath,
    installedSessionEnd,
    installedSessionStart,
    installedSessionCapture,
    migratedFromStop,
    migratedLegacySessionEnd,
  };
}

export function uninstallJsonHooks(target: JsonHookTarget): boolean {
  const { settings: settingsPath } = resolveJsonHookPaths(target);
  if (!fs.existsSync(settingsPath)) return false;

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return false;
  }

  const hooks = settings.hooks as Record<string, unknown[]> | undefined;
  if (!hooks) return false;

  let changed = false;
  const markersByKey: Record<string, string[]> = {
    SessionEnd: [HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER],
    SessionStart: [HIPPO_LAST_SLEEP_MARKER],
    Stop: [HIPPO_SLEEP_MARKER],
  };
  for (const [key, markers] of Object.entries(markersByKey)) {
    if (!Array.isArray(hooks[key])) continue;
    const before = hooks[key].length;
    hooks[key] = hooks[key].filter(
      (entry) => !markers.some((m) => JSON.stringify(entry).includes(m)),
    );
    if (hooks[key].length !== before) {
      changed = true;
      if (hooks[key].length === 0) delete hooks[key];
    }
  }

  if (!changed) return false;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}

/**
 * Detect which AI coding tools are installed based on config directory presence.
 * Used by `hippo setup` to decide which JSON-hook installs to run.
 */
export function detectInstalledTools(): ToolDetection[] {
  const home = homeDir();
  const exists = (...parts: string[]) => fs.existsSync(path.join(home, ...parts));
  return [
    { name: 'claude-code', configDir: '~/.claude', detected: exists('.claude'), kind: 'json-hook' },
    { name: 'opencode', configDir: '~/.config/opencode', detected: exists('.config', 'opencode'), kind: 'json-hook' },
    { name: 'openclaw', configDir: '~/.openclaw', detected: exists('.openclaw'), kind: 'plugin', notes: 'install via `openclaw plugins install hippo-memory`' },
    { name: 'codex', configDir: '~/.codex', detected: exists('.codex'), kind: 'markdown-instruction', notes: 'no hook API - patches AGENTS.md in the project' },
    { name: 'cursor', configDir: '~/.cursor', detected: exists('.cursor'), kind: 'markdown-instruction', notes: 'no hook API - patches .cursorrules in the project' },
    { name: 'pi', configDir: '~/.pi', detected: exists('.pi'), kind: 'markdown-instruction', notes: 'no hook API - patches AGENTS.md in the project' },
  ];
}
