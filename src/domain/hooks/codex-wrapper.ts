// The Codex launcher wrapper: where its files go, which paths an install may touch, and the script text it writes;
// surface/hooks-install/codex-wrapper.ts moves and writes the files.
import * as path from 'path';
import { PACKAGE_ROOT } from '../../base/config/package-root.js';
import { HIPPO_CODEX_WRAPPER_MARKER } from './shared.js';
import { codexHomeDir, userHome, type Homes } from '../../base/util/agent-homes.js';
import { isJsonString } from '../../base/util/json.js';

export interface CodexWrapperPaths {
  wrapperDir: string;
  metadataPath: string;
  wrapperCmdPath: string;
  wrapperPs1Path: string;
  wrapperShPath: string;
  logFile: string;
  runsDir: string;
  codexHome: string;
  historyPath: string;
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
  installedAt: string;
  /** The hippo CLI the user opted in; absent in metadata written before this field. */
  hippoCliPath?: string;
}

export interface EnsureCodexWrapperResult {
  status: 'installed' | 'already-installed' | 'not-found' | 'source-checkout' | 'other-install' | 'foreign-metadata';
  metadataPath?: string;
  realCodexPath?: string;
  commandPath?: string;
  backupPath?: string;
}

/** Where the wrapper, its metadata and its logs live under the machine's home folder. */
export function codexWrapperPathsOn(homes: Homes): CodexWrapperPaths {
  const home = userHome(homes);
  const codexHome = codexHomeDir(home, homes.env);
  const wrapperDir = path.join(home, '.hippo', 'bin');
  return {
    wrapperDir,
    metadataPath: path.join(home, '.hippo', 'integrations', 'codex.json'),
    wrapperCmdPath: path.join(wrapperDir, 'codex.cmd'),
    wrapperPs1Path: path.join(wrapperDir, 'codex.ps1'),
    wrapperShPath: path.join(wrapperDir, 'codex'),
    logFile: path.join(home, '.hippo', 'logs', 'codex-sleep.log'),
    runsDir: path.join(home, '.hippo', 'runs', 'codex'),
    codexHome,
    historyPath: path.join(codexHome, 'history.jsonl'),
  };
}

export function pathEquals(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// The launchers detectRealCodexPath looks for, so the only originals the installer can have recorded.
export const CODEX_LAUNCHER_NAMES: readonly string[] =
  process.platform === 'win32' ? ['codex.cmd', 'codex.ps1', 'codex.exe', 'codex'] : ['codex'];

/** Metadata the installer could have written: each path is the install plan of one codex launcher, so the one rename it
 * can drive is `codex.hippo-real<ext>` back onto that launcher. */
export function namesInstallerPaths(metadata: CodexWrapperMetadata): boolean {
  const { originalCodexPath, realCodexPath, commandPath, backupPath } = metadata;
  if (![originalCodexPath, realCodexPath, commandPath, backupPath].every(isJsonString)) return false;
  if (!path.isAbsolute(originalCodexPath)) return false;
  const name = path.basename(originalCodexPath);
  if (!CODEX_LAUNCHER_NAMES.includes(process.platform === 'win32' ? name.toLowerCase() : name)) return false;
  const plan = resolveCodexInstallPlan(originalCodexPath);
  return (
    pathEquals(backupPath, plan.backupPath) &&
    pathEquals(realCodexPath, plan.backupPath) &&
    pathEquals(commandPath, plan.commandPath)
  );
}

export function resolveHippoCliPath(): string {
  return path.join(PACKAGE_ROOT, 'bin', 'hippo.js');
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

export function resolveCodexInstallPlan(originalCodexPath: string) {
  const dir = path.dirname(originalCodexPath);
  const ext = path.extname(originalCodexPath).toLowerCase();
  const name = path.basename(originalCodexPath, ext);
  const backupPath = path.join(dir, `${name}.hippo-real${ext}`);

  if (process.platform === 'win32' && ext === '.exe') {
    return {
      commandPath: path.join(dir, `${name}.cmd`),
      backupPath,
      installMode: 'cmd-shim' as const,
    };
  }

  return {
    commandPath: originalCodexPath,
    backupPath,
    installMode: 'same-path' as const,
  };
}

/** The wrapper script for a launcher at `commandPath`: PowerShell for .ps1, cmd for .cmd or .bat on Windows, else sh;
 * each runs `hippo codex-run` with the user's arguments. */
export function codexLauncherWrapperText(commandPath: string, nodePath: string, hippoCliPath: string): string {
  const ext = path.extname(commandPath).toLowerCase();
  if (process.platform === 'win32' && ext === '.ps1') {
    return [
      `# ${HIPPO_CODEX_WRAPPER_MARKER}`,
      `& ${quoteForPowerShell(nodePath)} ${quoteForPowerShell(hippoCliPath)} codex-run -- @args`,
      '',
    ].join('\n');
  }
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return [
      '@echo off',
      `REM ${HIPPO_CODEX_WRAPPER_MARKER}`,
      `${quoteForCmd(nodePath)} ${quoteForCmd(hippoCliPath)} codex-run -- %*`,
      '',
    ].join('\r\n');
  }
  return [
    '#!/usr/bin/env sh',
    `# ${HIPPO_CODEX_WRAPPER_MARKER}`,
    `exec ${quoteForShell(nodePath)} ${quoteForShell(hippoCliPath)} codex-run -- "$@"`,
    '',
  ].join('\n');
}

export function installResult(metadataPath: string, metadata: CodexWrapperMetadata): CodexWrapperInstallResult {
  return {
    installed: true,
    metadataPath,
    realCodexPath: metadata.realCodexPath,
    commandPath: metadata.commandPath,
    backupPath: metadata.backupPath,
    installMode: metadata.installMode,
  };
}

/** Why a repair must not re-point the user's launcher, or null when it may: only the CLI the user opted in may, and
 * never a checkout, whose folder may be deleted. */
export function repairRefusal(
  metadata: CodexWrapperMetadata,
  hippoCliPath: string,
): 'other-install' | 'source-checkout' | null {
  if (isJsonString(metadata.hippoCliPath) && !pathEquals(metadata.hippoCliPath, hippoCliPath)) return 'other-install';
  const packageDir = path.dirname(path.dirname(hippoCliPath));
  if (path.basename(path.dirname(packageDir)).toLowerCase() !== 'node_modules') return 'source-checkout';
  return null;
}
