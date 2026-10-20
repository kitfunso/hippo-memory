import { envPath } from '../util/env.js';
import * as fs from 'fs';
import * as path from 'path';
import { PACKAGE_ROOT } from '../core/package-root.js';
import { errorCode, errorMessage, log, errorFields } from '../util/log.js';
import { HIPPO_CODEX_WRAPPER_MARKER, ensureDir } from './shared.js';
import { homeDir, codexHomeDir } from '../util/agent-homes.js';
import { isJsonString } from '../util/json.js';
import { writeFileAtomic } from '../util/atomic-write.js';

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

export function resolveCodexWrapperPaths(): CodexWrapperPaths {
  const home = homeDir();
  const codexHome = codexHomeDir(home);
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

function pathEquals(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function readCodexWrapperMetadata(): CodexWrapperMetadata | null {
  const { metadataPath } = resolveCodexWrapperPaths();
  if (!fs.existsSync(metadataPath)) return null;
  try {
    // This optimistic parse is never trusted directly: every call site reads fields off the result only after
    // isCodexWrapperMetadataValid has runtime-checked each string field and the referenced paths.
    const parsed: CodexWrapperMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return parsed;
  } catch (err) {
    // Unreadable metadata is treated like the missing-file case above, after the cause is logged.
    if (errorCode(err) !== 'ENOENT') {
      log.warn(`codex wrapper metadata ${metadataPath} unreadable: ${errorMessage(err)}`, errorFields(err));
    }
    return null;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // Callers treat an unreadable file as absent; only a missing one is silent.
    if (errorCode(err) !== 'ENOENT') {
      log.warn(`cannot read ${filePath}: ${errorMessage(err)}`, errorFields(err));
    }
    return null;
  }
}

function isHippoCodexWrapperFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const text = readTextFile(filePath);
  return text !== null && text.includes(HIPPO_CODEX_WRAPPER_MARKER);
}

// The launchers detectRealCodexPath looks for, so the only originals the installer can have recorded.
const CODEX_LAUNCHER_NAMES: readonly string[] =
  process.platform === 'win32' ? ['codex.cmd', 'codex.ps1', 'codex.exe', 'codex'] : ['codex'];

/** Metadata the installer could have written: each path is the install plan of one codex launcher, so the one rename it
 * can drive is `codex.hippo-real<ext>` back onto that launcher. */
function namesInstallerPaths(metadata: CodexWrapperMetadata): boolean {
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

function isCodexWrapperMetadataValid(metadata: CodexWrapperMetadata | null): metadata is CodexWrapperMetadata {
  if (!metadata) return false;
  return (
    namesInstallerPaths(metadata) &&
    fs.existsSync(metadata.realCodexPath) &&
    fs.existsSync(metadata.backupPath) &&
    isHippoCodexWrapperFile(metadata.commandPath)
  );
}

function resolveHippoCliPath(): string {
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

function resolveCodexInstallPlan(originalCodexPath: string) {
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

/** The Codex launcher `hippo codex-run` may start: only the backup the installer made, never a path the metadata names
 * on its own say. */
export function installedRealCodexPath(): string {
  const { metadataPath } = resolveCodexWrapperPaths();
  if (!fs.existsSync(metadataPath)) {
    throw new Error('Codex wrapper is not installed. Run `hippo hook install codex` first.');
  }
  const metadata = readCodexWrapperMetadata();
  if (!isCodexWrapperMetadataValid(metadata)) {
    throw new Error(
      `${metadataPath} does not describe a Codex wrapper hippo installed, so Codex was not started. ` +
        'Run `hippo hook install codex` again.',
    );
  }
  return metadata.realCodexPath;
}

export function detectRealCodexPath(): string | null {
  const metadata = readCodexWrapperMetadata();
  if (isCodexWrapperMetadataValid(metadata)) return metadata.realCodexPath;

  const { wrapperDir } = resolveCodexWrapperPaths();
  const entries = (envPath() ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !pathEquals(entry, wrapperDir));

  for (const entry of entries) {
    for (const name of CODEX_LAUNCHER_NAMES) {
      const candidate = path.join(entry, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

function writeExecutableFile(filePath: string, content: string): void {
  writeFileAtomic(filePath, content);
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    // The mode bit means nothing on Windows; elsewhere a wrapper that is not executable breaks `codex`, so say so.
    log.warn(`could not mark ${filePath} executable: ${errorMessage(err)}`, errorFields(err));
  }
}

export function installCodexWrapper(realCodexPath?: string): CodexWrapperInstallResult {
  const existingMetadata = readCodexWrapperMetadata();
  if (isCodexWrapperMetadataValid(existingMetadata) && !realCodexPath) {
    cleanupLegacyCodexPathWrappers(resolveCodexWrapperPaths());
    return installResult(resolveCodexWrapperPaths().metadataPath, existingMetadata);
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

  // A launcher that is not our wrapper is the current codex, so it replaces any older backup a Codex update left.
  if (!isHippoCodexWrapperFile(resolvedRealCodexPath)) {
    fs.renameSync(resolvedRealCodexPath, plan.backupPath);
  } else if (!fs.existsSync(plan.backupPath)) {
    throw new Error(`${resolvedRealCodexPath} is hippo's wrapper and the Codex it wrapped is gone; reinstall Codex.`);
  }
  writeCodexLauncherWrapper(plan.commandPath);

  const metadata: CodexWrapperMetadata = {
    originalCodexPath: resolvedRealCodexPath,
    realCodexPath: plan.backupPath,
    commandPath: plan.commandPath,
    backupPath: plan.backupPath,
    installMode: plan.installMode,
    logFile: paths.logFile,
    installedAt: new Date().toISOString(),
    hippoCliPath: resolveHippoCliPath(),
  };
  writeFileAtomic(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n');

  return installResult(paths.metadataPath, metadata);
}

function installResult(metadataPath: string, metadata: CodexWrapperMetadata): CodexWrapperInstallResult {
  return {
    installed: true,
    metadataPath,
    realCodexPath: metadata.realCodexPath,
    commandPath: metadata.commandPath,
    backupPath: metadata.backupPath,
    installMode: metadata.installMode,
  };
}

/** Moves files only along the install plan of the recorded launcher, and never puts the backup over a launcher that is
 * not our wrapper. */
function restoreCodexLauncher(metadata: CodexWrapperMetadata, metadataPath: string): boolean {
  if (!namesInstallerPaths(metadata)) {
    log.warn(`codex wrapper metadata ${metadataPath} names paths hippo never wrote; no launcher file was moved`);
    return false;
  }
  const { originalCodexPath } = metadata;
  const plan = resolveCodexInstallPlan(originalCodexPath);
  let changed = false;
  if (isHippoCodexWrapperFile(plan.commandPath)) {
    fs.rmSync(plan.commandPath, { force: true });
    changed = true;
  }
  if (!fs.existsSync(plan.backupPath)) return changed;
  if (fs.existsSync(originalCodexPath)) {
    log.warn(`kept ${plan.backupPath}: a newer codex launcher already sits at ${originalCodexPath}`);
    return changed;
  }
  fs.renameSync(plan.backupPath, originalCodexPath);
  return true;
}

export function uninstallCodexWrapper(): boolean {
  const paths = resolveCodexWrapperPaths();
  const metadata = readCodexWrapperMetadata();
  let changed = metadata !== null && restoreCodexLauncher(metadata, paths.metadataPath);

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
    const { metadataPath } = resolveCodexWrapperPaths();
    // Metadata hippo never wrote could aim a repair at any file, so it changes nothing until the user reinstalls.
    if (!namesInstallerPaths(metadata)) {
      log.warn(
        `codex wrapper metadata ${metadataPath} names paths hippo never wrote, so the wrapper was not ` +
          'repaired; run `hippo hook install codex` to replace it',
      );
      return { status: 'foreign-metadata', metadataPath };
    }
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

/**
 * True if Codex wrapper metadata exists on this machine, i.e. the user opted in to the wrapper at some point (via
 * `hippo hook install codex`).
 */
export function isCodexWrapperInstalled(): boolean {
  return readCodexWrapperMetadata() !== null;
}

/**
 * Repair-only variant of `ensureCodexWrapperInstalled`: re-ensures the wrapper
 * ONLY when wrapper metadata already exists; that metadata is the user's opt-in record. Never performs a first install.
 * Replacing another vendor's binary must stay behind the explicit `hippo hook install codex` command; doing it from
 * postinstall or routine commands is a consent violation and reads as binary hijacking to security scanners.
 */
export function repairCodexWrapperIfInstalled(hippoCliPath: string = resolveHippoCliPath()): EnsureCodexWrapperResult {
  const metadata = readCodexWrapperMetadata();
  if (metadata === null) {
    return { status: 'not-found' };
  }
  // Only the CLI the user opted in may re-point their launcher, not an npx cache or a project dependency.
  if (isJsonString(metadata.hippoCliPath) && !pathEquals(metadata.hippoCliPath, hippoCliPath)) {
    return { status: 'other-install' };
  }
  // A checkout's own `npm install` or CLI would point the user's launcher at a folder that may be deleted.
  const packageDir = path.dirname(path.dirname(hippoCliPath));
  if (path.basename(path.dirname(packageDir)).toLowerCase() !== 'node_modules') {
    return { status: 'source-checkout' };
  }
  return ensureCodexWrapperInstalled();
}
