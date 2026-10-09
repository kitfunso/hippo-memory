import { envPath } from '../env.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { errorMessage, log } from '../log.js';
import { HIPPO_CODEX_WRAPPER_MARKER, homeDir, codexHomeDir, ensureDir } from './shared.js';
import { isJsonString } from '../json.js';
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
}

export interface EnsureCodexWrapperResult {
  status: 'installed' | 'already-installed' | 'not-found' | 'source-checkout';
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
    // This optimistic parse is never trusted directly — every call site reads fields off
    // the result only after isCodexWrapperMetadataValid has runtime-checked each string
    // field and the referenced paths.
    const parsed: CodexWrapperMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return parsed;
  } catch {
    // Unreadable metadata is treated like the missing-file case above.
    return null;
  }
}

function readTextFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    // Callers treat an unreadable file as absent.
    return null;
  }
}

function isHippoCodexWrapperFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  const text = readTextFile(filePath);
  return text !== null && text.includes(HIPPO_CODEX_WRAPPER_MARKER);
}

function isCodexWrapperMetadataValid(metadata: CodexWrapperMetadata | null): metadata is CodexWrapperMetadata {
  if (!metadata) return false;
  return (
    isJsonString(metadata.originalCodexPath) &&
    isJsonString(metadata.realCodexPath) &&
    isJsonString(metadata.commandPath) &&
    isJsonString(metadata.backupPath) &&
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

export function detectRealCodexPath(): string | null {
  const metadata = readCodexWrapperMetadata();
  if (isCodexWrapperMetadataValid(metadata)) return metadata.realCodexPath;

  const { wrapperDir } = resolveCodexWrapperPaths();
  const entries = (envPath() ?? '')
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

function writeExecutableFile(filePath: string, content: string): void {
  writeFileAtomic(filePath, content);
  try {
    fs.chmodSync(filePath, 0o755);
  } catch (err) {
    // The mode bit means nothing on Windows; elsewhere a wrapper that is not executable breaks `codex`, so say so.
    log.warn(`could not mark ${filePath} executable: ${errorMessage(err)}`);
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
    installedAt: new Date().toISOString(),
  };
  writeFileAtomic(paths.metadataPath, JSON.stringify(metadata, null, 2) + '\n');

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

/**
 * True if Codex wrapper metadata exists on this machine, i.e. the user opted
 * in to the wrapper at some point (via `hippo hook install codex`).
 */
export function isCodexWrapperInstalled(): boolean {
  return readCodexWrapperMetadata() !== null;
}

/**
 * Repair-only variant of `ensureCodexWrapperInstalled`: re-ensures the wrapper
 * ONLY when wrapper metadata already exists — that metadata is the user's
 * opt-in record. Never performs a first install. Replacing another vendor's
 * binary must stay behind the explicit `hippo hook install codex` command;
 * doing it from postinstall or routine commands is a consent violation and
 * reads as binary hijacking to security scanners.
 */
export function repairCodexWrapperIfInstalled(hippoCliPath: string = resolveHippoCliPath()): EnsureCodexWrapperResult {
  if (readCodexWrapperMetadata() === null) {
    return { status: 'not-found' };
  }
  // A checkout's own `npm install` or CLI would point the user's launcher at a folder that may be deleted.
  // SHORTCUT: any node_modules copy (npx cache, a project dependency) still repairs; record the opted-in CLI path in the metadata to close that.
  const packageDir = path.dirname(path.dirname(hippoCliPath));
  if (path.basename(path.dirname(packageDir)).toLowerCase() !== 'node_modules') {
    return { status: 'source-checkout' };
  }
  return ensureCodexWrapperInstalled();
}
