/**
 * Hook install/uninstall for AI coding tools.
 *
 * Two integration models live in this file:
 *
 * 1. JSON-hook install (Claude Code only). Writes a `hooks` block into the
 *    tool's settings.json with two entries:
 *      - SessionEnd: `hippo session-end --log-file <path>` - spawns a detached
 *        child that runs `hippo sleep` then `hippo capture --last-session` in
 *        sequence, writing both outputs to the log file. The parent returns in
 *        <100ms so the TUI teardown can't kill the child before it finishes.
 *      - SessionStart: `hippo last-sleep --path <path>` - prints the log
 *        written by the previous session's detached worker and then clears it,
 *        so the user actually sees what was consolidated.
 *    Earlier Claude Code forms are detected and migrated automatically:
 *      - < 0.20.2: `Stop` hook firing `hippo sleep` on every assistant turn.
 *      - < 0.21.0: bare `hippo sleep` in SessionEnd, no `--log-file`.
 *      - 0.22.x: separate sleep + capture SessionEnd entries.
 *
 * 2. Plugin install (OpenCode only). OpenCode does NOT share Claude Code's
 *    JSON-hook schema — its config has `additionalProperties: false` and no
 *    `hooks` key, so v1.10.x-v1.11.1's JSON-hook installer broke opencode
 *    launch (issue #24). Hippo now installs a TypeScript plugin at
 *    `~/.config/opencode/plugins/hippo.ts` subscribing to opencode's
 *    `session.idle` (→ `hippo session-end`) and `session.created` (→
 *    `hippo last-sleep`) events. See OPENCODE_PLUGIN_SOURCE below for the
 *    plugin file content + design rationale; see installOpencodePlugin for
 *    the installer + the migration that removes any pre-existing broken
 *    `hooks` block from opencode.json.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

export type JsonHookTarget = 'claude-code';

export interface CodexWrapperPaths {
  wrapperDir: string;
  metadataPath: string;
  wrapperCmdPath: string;
  wrapperPs1Path: string;
  wrapperShPath: string;
  logFile: string;
  runsDir: string;
  historyPath: string;
  sessionsDir: string;
}

export interface CodexWrapperInstallResult {
  installed: boolean;
  metadataPath: string;
  realCodexPath: string;
  commandPath: string;
  backupPath: string;
  installMode: 'same-path' | 'cmd-shim';
}

export interface CodexWrapperMetadata {
  originalCodexPath: string;
  realCodexPath: string;
  commandPath: string;
  backupPath: string;
  installMode: 'same-path' | 'cmd-shim';
  logFile: string;
  historyPath: string;
  sessionsDir: string;
  installedAt: string;
}

export interface EnsureCodexWrapperResult {
  status: 'installed' | 'already-installed' | 'not-found';
  metadataPath?: string;
  realCodexPath?: string;
  commandPath?: string;
  backupPath?: string;
}

export interface CodexSessionTranscriptOptions {
  codexHome: string;
  historyPath: string;
  startOffsetBytes: number;
  startedAtMs: number;
}

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
  installedUserPromptSubmit: boolean;
  migratedPinnedInjectRecent: boolean;
  migratedFromStop: boolean;
  migratedLegacySessionEnd: boolean;
  migratedSplitSessionEnd: boolean;
}

export interface ToolDetection {
  name: string;
  configDir: string;
  detected: boolean;
  kind: 'json-hook' | 'markdown-instruction' | 'plugin' | 'wrapper';
  notes?: string;
}

const HIPPO_SLEEP_MARKER = 'hippo sleep';
const HIPPO_LAST_SLEEP_MARKER = 'hippo last-sleep';
const HIPPO_CAPTURE_MARKER = 'hippo capture --last-session';
const HIPPO_SESSION_END_MARKER = 'hippo session-end';
const HIPPO_PINNED_INJECT_MARKER = 'hippo context --pinned-only';
const HIPPO_PINNED_INJECT_COMMAND = 'hippo context --pinned-only --include-recent 5 --format additional-context';
const HIPPO_CODEX_WRAPPER_MARKER = 'hippo codex wrapper';

const HIPPO_OPENCODE_PLUGIN_MARKER = 'HIPPO_OPENCODE_PLUGIN_V1';

/**
 * The opencode plugin file we install at ~/.config/opencode/plugins/hippo.ts.
 *
 * Per https://opencode.ai/docs/plugins/, plugins are TS/JS modules exporting an
 * async function returning hooks. We subscribe to `event` and route:
 *   session.idle    → `hippo session-end` (Claude Code's SessionEnd equiv)
 *   session.created → `hippo last-sleep` (Claude Code's SessionStart equiv)
 *
 * Design choices forced by plan-eng-critic Rev 0 review (2026-05-23):
 *
 * 1. No `import type { Plugin } from "@opencode-ai/plugin"`. The package's npm
 *    publication status was unverifiable from the build sandbox (npmjs.com
 *    returned 403); an unresolved type-only import would still crash the TS
 *    runtime opencode uses to load the plugin. opencode infers plugin shape
 *    from the returned object, so the type was convenience-only.
 *
 * 2. Defensive `typeof $ !== 'function'` guard. opencode runs in Bun (where
 *    `$` is the shell-template helper), but a future Node-mode deployment
 *    would have `$` undefined in the destructured context and the plugin
 *    would throw on every session.idle, killing opencode sessions in a
 *    hard-to-recover way (the idempotence marker prevents auto-reinstall).
 *    Fail closed, let opencode continue.
 *
 * 3. `.quiet().nothrow()` on each `$\`...\`` so a missing hippo binary
 *    (e.g. PATH-misconfigured user) does NOT throw out of the event handler.
 *    The surrounding try/catch is belt-and-braces.
 *
 * 4. UserPromptSubmit equivalent NOT wired. opencode's `message.updated`
 *    fires per-token, not per-prompt-submit; no clean per-prompt event.
 *    Users wanting pinned-context auto-injection can call `hippo context`
 *    via the MCP server (`hippo mcp`).
 *
 * 5. Versioned marker `HIPPO_OPENCODE_PLUGIN_V1` allows future versions to
 *    overwrite cleanly. The installer's idempotence check requires BOTH
 *    marker match AND content equality, so a plugin-source revision under
 *    the same V1 marker re-writes the file on next install.
 */
export const OPENCODE_PLUGIN_SOURCE = `// ${HIPPO_OPENCODE_PLUGIN_MARKER}
// hippo-memory opencode plugin. DO NOT EDIT — regenerated on every
// \`hippo hook install opencode\` from src/hooks.ts OPENCODE_PLUGIN_SOURCE
// in https://github.com/kitfunso/hippo-memory. Local changes will be lost.

export const HippoPlugin = async ({ $ }) => {
  return {
    event: async ({ event }) => {
      // Defense in depth: opencode currently runs in Bun where $ is the shell
      // template helper. A non-Bun runtime would have $ as undefined; fail
      // closed instead of crashing the host session.
      if (typeof $ !== "function") return;
      try {
        if (event.type === "session.idle") {
          await $\`hippo session-end\`.quiet().nothrow();
        } else if (event.type === "session.created") {
          await $\`hippo last-sleep\`.quiet().nothrow();
        }
      } catch {
        // hippo CLI not on PATH or other failure — never crash the host session.
      }
    },
  };
};
`;

export { HIPPO_OPENCODE_PLUGIN_MARKER };

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

export function resolveCodexWrapperPaths(): CodexWrapperPaths {
  const home = homeDir();
  const codexHome = path.join(home, '.codex');
  const wrapperDir = path.join(home, '.hippo', 'bin');
  return {
    wrapperDir,
    metadataPath: path.join(home, '.hippo', 'integrations', 'codex.json'),
    wrapperCmdPath: path.join(wrapperDir, 'codex.cmd'),
    wrapperPs1Path: path.join(wrapperDir, 'codex.ps1'),
    wrapperShPath: path.join(wrapperDir, 'codex'),
    logFile: path.join(home, '.hippo', 'logs', 'codex-sleep.log'),
    runsDir: path.join(home, '.hippo', 'runs', 'codex'),
    historyPath: path.join(codexHome, 'history.jsonl'),
    sessionsDir: path.join(codexHome, 'sessions'),
  };
}

function pathEquals(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function readCodexWrapperMetadata(): CodexWrapperMetadata | null {
  const { metadataPath } = resolveCodexWrapperPaths();
  if (!fs.existsSync(metadataPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as CodexWrapperMetadata;
  } catch {
    return null;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isHippoCodexWrapperFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const text = readTextFile(filePath);
  return typeof text === 'string' && text.includes(HIPPO_CODEX_WRAPPER_MARKER);
}

function isCodexWrapperMetadataValid(metadata: CodexWrapperMetadata | null): metadata is CodexWrapperMetadata {
  if (!metadata) return false;
  return (
    typeof metadata.originalCodexPath === 'string' &&
    typeof metadata.realCodexPath === 'string' &&
    typeof metadata.commandPath === 'string' &&
    typeof metadata.backupPath === 'string' &&
    fs.existsSync(metadata.realCodexPath) &&
    fs.existsSync(metadata.backupPath) &&
    isHippoCodexWrapperFile(metadata.commandPath)
  );
}

function resolveHippoCliPath(): string {
  return fileURLToPath(new URL('../bin/hippo.js', import.meta.url));
}

function quoteForShell(value: string): string {
  return `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function resolveCodexInstallPlan(originalCodexPath: string): {
  commandPath: string;
  backupPath: string;
  installMode: 'same-path' | 'cmd-shim';
} {
  const dir = path.dirname(originalCodexPath);
  const ext = path.extname(originalCodexPath).toLowerCase();
  const name = path.basename(originalCodexPath, ext);
  const backupPath = path.join(dir, `${name}.hippo-real${ext}`);

  if (process.platform === 'win32' && ext === '.exe') {
    return {
      commandPath: path.join(dir, `${name}.cmd`),
      backupPath,
      installMode: 'cmd-shim',
    };
  }

  return {
    commandPath: originalCodexPath,
    backupPath,
    installMode: 'same-path',
  };
}

function writeCodexLauncherWrapper(commandPath: string): void {
  const ext = path.extname(commandPath).toLowerCase();
  const nodePath = process.execPath;
  const hippoCliPath = resolveHippoCliPath();

  if (process.platform === 'win32' && ext === '.ps1') {
    writeExecutableFile(
      commandPath,
      [
        `# ${HIPPO_CODEX_WRAPPER_MARKER}`,
        `& ${quoteForPowerShell(nodePath)} ${quoteForPowerShell(hippoCliPath)} codex-run -- @args`,
        '',
      ].join('\n'),
    );
    return;
  }

  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    writeExecutableFile(
      commandPath,
      [
        '@echo off',
        `REM ${HIPPO_CODEX_WRAPPER_MARKER}`,
        `${quoteForCmd(nodePath)} ${quoteForCmd(hippoCliPath)} codex-run -- %*`,
        '',
      ].join('\r\n'),
    );
    return;
  }

  writeExecutableFile(
    commandPath,
    [
      '#!/usr/bin/env sh',
      `# ${HIPPO_CODEX_WRAPPER_MARKER}`,
      `exec ${quoteForShell(nodePath)} ${quoteForShell(hippoCliPath)} codex-run -- "$@"`,
      '',
    ].join('\n'),
  );
}

function cleanupLegacyCodexPathWrappers(paths: CodexWrapperPaths): void {
  for (const filePath of [paths.wrapperCmdPath, paths.wrapperPs1Path, paths.wrapperShPath]) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  }
}

export function detectRealCodexPath(): string | null {
  const metadata = readCodexWrapperMetadata();
  if (isCodexWrapperMetadataValid(metadata)) return metadata.realCodexPath;

  const { wrapperDir } = resolveCodexWrapperPaths();
  const entries = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !pathEquals(entry, wrapperDir));

  const names = process.platform === 'win32'
    ? ['codex.cmd', 'codex.ps1', 'codex.exe', 'codex']
    : ['codex'];

  for (const entry of entries) {
    for (const name of names) {
      const candidate = path.join(entry, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeExecutableFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // chmod is best-effort on Windows
  }
}

export function installCodexWrapper(realCodexPath?: string): CodexWrapperInstallResult {
  const existingMetadata = readCodexWrapperMetadata();
  if (isCodexWrapperMetadataValid(existingMetadata) && !realCodexPath) {
    cleanupLegacyCodexPathWrappers(resolveCodexWrapperPaths());
    return {
      installed: true,
      metadataPath: resolveCodexWrapperPaths().metadataPath,
      realCodexPath: existingMetadata.realCodexPath,
      commandPath: existingMetadata.commandPath,
      backupPath: existingMetadata.backupPath,
      installMode: existingMetadata.installMode,
    };
  }

  const resolvedRealCodexPath = realCodexPath ?? detectRealCodexPath();
  if (!resolvedRealCodexPath) {
    throw new Error('Could not locate the real Codex executable on PATH.');
  }

  const paths = resolveCodexWrapperPaths();
  ensureDir(path.dirname(paths.metadataPath));
  ensureDir(path.dirname(paths.logFile));
  ensureDir(paths.runsDir);
  cleanupLegacyCodexPathWrappers(paths);

  const plan = resolveCodexInstallPlan(resolvedRealCodexPath);
  ensureDir(path.dirname(plan.commandPath));

  if (isCodexWrapperMetadataValid(existingMetadata)) {
    uninstallCodexWrapper();
  }

  if (!fs.existsSync(plan.backupPath)) {
    fs.renameSync(resolvedRealCodexPath, plan.backupPath);
  }
  writeCodexLauncherWrapper(plan.commandPath);

  const metadata: CodexWrapperMetadata = {
    originalCodexPath: resolvedRealCodexPath,
    realCodexPath: plan.backupPath,
    commandPath: plan.commandPath,
    backupPath: plan.backupPath,
    installMode: plan.installMode,
    logFile: paths.logFile,
    historyPath: paths.historyPath,
    sessionsDir: paths.sessionsDir,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  return {
    installed: true,
    metadataPath: paths.metadataPath,
    realCodexPath: metadata.realCodexPath,
    commandPath: metadata.commandPath,
    backupPath: metadata.backupPath,
    installMode: metadata.installMode,
  };
}

export function uninstallCodexWrapper(): boolean {
  const paths = resolveCodexWrapperPaths();
  let changed = false;

  const metadata = readCodexWrapperMetadata();
  if (metadata) {
    if (fs.existsSync(metadata.commandPath) && isHippoCodexWrapperFile(metadata.commandPath)) {
      fs.rmSync(metadata.commandPath, { force: true });
      changed = true;
    }
    if (fs.existsSync(metadata.backupPath)) {
      fs.renameSync(metadata.backupPath, metadata.originalCodexPath);
      changed = true;
    }
  }

  cleanupLegacyCodexPathWrappers(paths);

  if (fs.existsSync(paths.metadataPath)) {
    fs.rmSync(paths.metadataPath, { force: true });
    changed = true;
  }

  return changed;
}

export function ensureCodexWrapperInstalled(): EnsureCodexWrapperResult {
  const metadata = readCodexWrapperMetadata();
  if (isCodexWrapperMetadataValid(metadata)) {
    cleanupLegacyCodexPathWrappers(resolveCodexWrapperPaths());
    return {
      status: 'already-installed',
      metadataPath: resolveCodexWrapperPaths().metadataPath,
      realCodexPath: metadata.realCodexPath,
      commandPath: metadata.commandPath,
      backupPath: metadata.backupPath,
    };
  }

  if (metadata) {
    uninstallCodexWrapper();
  }

  const detectedRealCodexPath = detectRealCodexPath();
  if (!detectedRealCodexPath) {
    return { status: 'not-found' };
  }

  const result = installCodexWrapper(detectedRealCodexPath);
  return {
    status: 'installed',
    metadataPath: result.metadataPath,
    realCodexPath: result.realCodexPath,
    commandPath: result.commandPath,
    backupPath: result.backupPath,
  };
}

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function readCodexSessionIdsFromHistoryDelta(historyPath: string, startOffsetBytes: number): string[] {
  if (!fs.existsSync(historyPath)) return [];
  const raw = fs.readFileSync(historyPath);
  if (startOffsetBytes >= raw.length) return [];
  const delta = raw.subarray(startOffsetBytes).toString('utf8');
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const line of delta.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const sessionId = parsed.session_id;
      if (typeof sessionId === 'string' && sessionId && !seen.has(sessionId)) {
        seen.add(sessionId);
        ordered.push(sessionId);
      }
    } catch {
      // ignore malformed JSONL lines
    }
  }

  return ordered;
}

function findCodexTranscriptBySessionId(sessionsDir: string, sessionId: string): string | null {
  const matches = collectFiles(sessionsDir).filter(
    (filePath) => filePath.endsWith('.jsonl') && filePath.includes(sessionId),
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0];
}

function findNewestCodexTranscriptSince(sessionsDir: string, startedAtMs: number): string | null {
  const matches = collectFiles(sessionsDir)
    .filter((filePath) => filePath.endsWith('.jsonl'))
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .filter((entry) => entry.mtimeMs >= startedAtMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return matches[0]?.filePath ?? null;
}

export function resolveCodexSessionTranscript(options: CodexSessionTranscriptOptions): string | null {
  const { codexHome, historyPath, startOffsetBytes, startedAtMs } = options;
  const sessionsDir = path.join(codexHome, 'sessions');

  for (const sessionId of readCodexSessionIdsFromHistoryDelta(historyPath, startOffsetBytes).reverse()) {
    const transcript = findCodexTranscriptBySessionId(sessionsDir, sessionId);
    if (transcript) return transcript;
  }

  return findNewestCodexTranscriptSince(sessionsDir, startedAtMs);
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
  }
}

function hookArrayContains(hookArray: unknown, marker: string): boolean {
  if (!Array.isArray(hookArray)) return false;
  return JSON.stringify(hookArray).includes(marker);
}

function addIncludeRecentToPinnedCommand(command: string): string {
  if (!command.includes(HIPPO_PINNED_INJECT_MARKER) || command.includes('--include-recent')) return command;
  return command.includes(' --format ')
    ? command.replace(' --format ', ' --include-recent 5 --format ')
    : `${command} --include-recent 5`;
}

function migratePinnedInjectRecentCommands(hookArray: unknown): boolean {
  if (!Array.isArray(hookArray)) return false;
  let changed = false;
  for (const entry of hookArray) {
    if (!entry || typeof entry !== 'object') continue;
    const hooks = (entry as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (!hook || typeof hook !== 'object') continue;
      const rec = hook as { command?: unknown };
      if (typeof rec.command !== 'string') continue;
      const next = addIncludeRecentToPinnedCommand(rec.command);
      if (next !== rec.command) {
        rec.command = next;
        changed = true;
      }
    }
  }
  return changed;
}

function hasCurrentSessionEnd(hookArray: unknown): boolean {
  return hookArrayContains(hookArray, HIPPO_SESSION_END_MARKER);
}

/**
 * Returns true when `hooks.SessionEnd` still contains either of the legacy
 * v0.22.x split entries (bare `hippo sleep` / `hippo capture --last-session`)
 * without the current consolidated `hippo session-end` entry.
 */
function hasLegacySplitSessionEnd(hookArray: unknown): boolean {
  if (!Array.isArray(hookArray)) return false;
  const serialized = JSON.stringify(hookArray);
  const hasSleep = serialized.includes(HIPPO_SLEEP_MARKER);
  const hasCapture = serialized.includes(HIPPO_CAPTURE_MARKER);
  return (hasSleep || hasCapture) && !serialized.includes(HIPPO_SESSION_END_MARKER);
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
        installedUserPromptSubmit: false,
        migratedPinnedInjectRecent: false,
        migratedFromStop: false,
        migratedLegacySessionEnd: false,
        migratedSplitSessionEnd: false,
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

  // Migrate legacy SessionEnd forms:
  //   - pre-0.21 bare `hippo sleep`
  //   - 0.21.x+ `hippo sleep --log-file` split across two entries
  //   - 0.22.x `hippo capture --last-session --log-file` second entry
  // All of these get collapsed into the single `hippo session-end` entry.
  let migratedLegacySessionEnd = false;
  let migratedSplitSessionEnd = false;
  if (Array.isArray(hooks.SessionEnd) && hasLegacySplitSessionEnd(hooks.SessionEnd)) {
    const before = hooks.SessionEnd.length;
    hooks.SessionEnd = hooks.SessionEnd.filter((entry) => {
      const s = JSON.stringify(entry);
      return !s.includes(HIPPO_SLEEP_MARKER) && !s.includes(HIPPO_CAPTURE_MARKER);
    });
    if (hooks.SessionEnd.length === 0) delete hooks.SessionEnd;
    // If the removed entries used the log-file pattern (0.21.x-0.22.x) we
    // call it a "split" migration; otherwise it was the older bare form.
    migratedSplitSessionEnd = true;
    migratedLegacySessionEnd = before > 1;
  }

  let installedSessionEnd = false;
  if (!hasCurrentSessionEnd(hooks.SessionEnd)) {
    if (!Array.isArray(hooks.SessionEnd)) hooks.SessionEnd = [];
    hooks.SessionEnd.push({
      hooks: [
        {
          type: 'command',
          command: `hippo session-end --log-file "${logFile}"`,
          timeout: 5,
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

  // Mid-session pinned-rule re-injection: UserPromptSubmit runs every turn,
  // so pinned memories stay in context even after the model would otherwise
  // "forget" them in a long session. Include the fresh write tail so lessons
  // saved earlier in the same session become visible on the next prompt even
  // before the user pins them explicitly.
  let installedUserPromptSubmit = false;
  const migratedPinnedInjectRecent = migratePinnedInjectRecentCommands(hooks.UserPromptSubmit);
  if (!hookArrayContains(hooks.UserPromptSubmit, HIPPO_PINNED_INJECT_MARKER)) {
    if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];
    hooks.UserPromptSubmit.push({
      hooks: [
        {
          type: 'command',
          command: HIPPO_PINNED_INJECT_COMMAND,
          timeout: 5,
        },
      ],
    });
    installedUserPromptSubmit = true;
  }

  if (
    installedSessionEnd ||
    installedSessionStart ||
    installedUserPromptSubmit ||
    migratedPinnedInjectRecent ||
    migratedFromStop ||
    migratedLegacySessionEnd ||
    migratedSplitSessionEnd
  ) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }

  return {
    target,
    settingsPath,
    installedSessionEnd,
    installedSessionStart,
    installedUserPromptSubmit,
    migratedPinnedInjectRecent,
    migratedFromStop,
    migratedLegacySessionEnd,
    migratedSplitSessionEnd,
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
    SessionEnd: [HIPPO_SESSION_END_MARKER, HIPPO_SLEEP_MARKER, HIPPO_CAPTURE_MARKER],
    SessionStart: [HIPPO_LAST_SLEEP_MARKER],
    UserPromptSubmit: [HIPPO_PINNED_INJECT_MARKER],
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

// ---------------------------------------------------------------------------
// OpenCode plugin installer (fix for issue #24).
//
// OpenCode does NOT share Claude Code's JSON-hook schema. Its config has
// `additionalProperties: false` and no `hooks` key, so the v1.10.x-v1.11.1
// installer broke opencode launch. The fix writes a TS plugin at the canonical
// plugin path and surgically migrates any pre-existing broken hooks block out
// of opencode.json.
// ---------------------------------------------------------------------------

export interface OpencodePluginInstallResult {
  installed: boolean;
  pluginPath: string;
  migratedLegacyHooks: boolean;
  jsonRepairFailed: boolean;
}

export function resolveOpencodePluginPath(): string {
  return path.join(homeDir(), '.config', 'opencode', 'plugins', 'hippo.ts');
}

function resolveOpencodeConfigPath(): string {
  return path.join(homeDir(), '.config', 'opencode', 'opencode.json');
}

/**
 * Return true iff a single hook-array entry's command string starts with
 * `hippo ` (the verb-prefix). Used to surgically remove only hippo-owned
 * commands when migrating an opencode.json. We own the install side, so only
 * the canonical `hippo <verb>` form needs to match — and only canonical verbs
 * hippo itself installs (session-end, last-sleep, sleep, capture, context),
 * not any third-party tool that happens to be named `hippo`.
 *
 * Critic-mandated structural check (Rev 0): substring matching against
 * arbitrary user content is unsafe — a user's
 * `echo "remember to hippo sleep your laptop"` is not a hippo-owned hook.
 *
 * Per-hook (not per-entry) granularity (Rev 1 review): an entry whose inner
 * hooks array mixes hippo-installed commands with user-authored commands
 * must NOT lose the user-authored commands. The migration filters the inner
 * array per-hook, then drops the entry only when its inner array is empty.
 */
const HIPPO_OWNED_COMMAND_RE = /^\s*hippo\s+(session-end|last-sleep|sleep|capture|context)\b/;

function hookIsHippoOwned(hook: unknown): boolean {
  if (!hook || typeof hook !== 'object') return false;
  const cmd = (hook as { command?: unknown }).command;
  return typeof cmd === 'string' && HIPPO_OWNED_COMMAND_RE.test(cmd);
}

/**
 * Structurally strip every hippo-owned hook from opencode.json's hooks key.
 * Returns one of:
 *   { migrated: true,  jsonRepairFailed: false } — at least one hook removed.
 *   { migrated: false, jsonRepairFailed: false } — file fine, nothing to do.
 *   { migrated: false, jsonRepairFailed: true  } — file present but unparseable.
 *
 * Per-hook surgery:
 *   - For each entry in each event-key array, filter the inner `hooks` array
 *     to remove hippo-owned hooks only. User-authored hooks in the same
 *     inner array are preserved.
 *   - When an entry's inner `hooks` array becomes empty, that entry is
 *     removed from the outer array.
 *   - When an event-key array becomes empty, the key is deleted.
 *   - When the top-level `hooks` object becomes empty, it is deleted.
 *   - Other keys (theme, etc.) are always preserved.
 */
function migrateLegacyOpencodeHooksBlock(): { migrated: boolean; jsonRepairFailed: boolean } {
  const configPath = resolveOpencodeConfigPath();
  if (!fs.existsSync(configPath)) return { migrated: false, jsonRepairFailed: false };

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { migrated: false, jsonRepairFailed: true };
  }

  const hooks = settings.hooks;
  // Non-object hooks values (string, array, null) are user content we don't
  // recognise — leave them alone, return migrated=false.
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return { migrated: false, jsonRepairFailed: false };
  }

  const hooksObj = hooks as Record<string, unknown[]>;
  let changed = false;
  for (const key of Object.keys(hooksObj)) {
    if (!Array.isArray(hooksObj[key])) continue;
    const survivingEntries: unknown[] = [];
    for (const entry of hooksObj[key]) {
      if (!entry || typeof entry !== 'object') {
        survivingEntries.push(entry);
        continue;
      }
      const innerHooks = (entry as { hooks?: unknown }).hooks;
      if (!Array.isArray(innerHooks)) {
        survivingEntries.push(entry);
        continue;
      }
      const beforeInner = innerHooks.length;
      const survivingInner = innerHooks.filter((h) => !hookIsHippoOwned(h));
      if (survivingInner.length !== beforeInner) changed = true;
      if (survivingInner.length === 0) continue; // drop entry, nothing left
      (entry as { hooks: unknown[] }).hooks = survivingInner;
      survivingEntries.push(entry);
    }
    if (survivingEntries.length !== hooksObj[key].length) changed = true;
    hooksObj[key] = survivingEntries;
    if (hooksObj[key].length === 0) delete hooksObj[key];
  }

  if (!changed) return { migrated: false, jsonRepairFailed: false };

  if (Object.keys(hooksObj).length === 0) delete settings.hooks;
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return { migrated: true, jsonRepairFailed: false };
}

export function installOpencodePlugin(): OpencodePluginInstallResult {
  const pluginPath = resolveOpencodePluginPath();
  const { migrated, jsonRepairFailed } = migrateLegacyOpencodeHooksBlock();

  // Idempotence: skip the write only if BOTH the marker is present AND the
  // content matches the current source. Marker-only matches (with stale
  // content) overwrite cleanly so future plugin-source patches reach
  // existing installs.
  if (fs.existsSync(pluginPath)) {
    const existing = fs.readFileSync(pluginPath, 'utf8');
    if (existing.includes(HIPPO_OPENCODE_PLUGIN_MARKER) && existing === OPENCODE_PLUGIN_SOURCE) {
      return { installed: false, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
    }
  }
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, OPENCODE_PLUGIN_SOURCE, 'utf8');
  return { installed: true, pluginPath, migratedLegacyHooks: migrated, jsonRepairFailed };
}

export function uninstallOpencodePlugin(): boolean {
  const pluginPath = resolveOpencodePluginPath();
  let removedFile = false;
  if (fs.existsSync(pluginPath)) {
    const existing = fs.readFileSync(pluginPath, 'utf8');
    if (existing.includes(HIPPO_OPENCODE_PLUGIN_MARKER)) {
      fs.unlinkSync(pluginPath);
      removedFile = true;
    }
  }
  // Always run the legacy migration on uninstall — the downgrade path (user
  // removing hippo entirely) must leave opencode launchable.
  const { migrated } = migrateLegacyOpencodeHooksBlock();
  return removedFile || migrated;
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
    { name: 'opencode', configDir: '~/.config/opencode', detected: exists('.config', 'opencode'), kind: 'plugin', notes: 'installs a TS plugin at ~/.config/opencode/plugins/hippo.ts' },
    { name: 'openclaw', configDir: '~/.openclaw', detected: exists('.openclaw'), kind: 'plugin', notes: 'install via `openclaw plugins install hippo-memory`' },
    { name: 'codex', configDir: '~/.codex', detected: exists('.codex'), kind: 'wrapper', notes: 'wraps the detected codex launcher for session-end consolidation' },
    { name: 'cursor', configDir: '~/.cursor', detected: exists('.cursor'), kind: 'markdown-instruction', notes: 'no hook API - patches .cursorrules in the project' },
    { name: 'pi', configDir: '~/.pi', detected: exists('.pi'), kind: 'markdown-instruction', notes: 'no hook API - patches AGENTS.md in the project' },
  ];
}
