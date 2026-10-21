// Installs and removes the Codex launcher wrapper on disk: reads its metadata, moves the launcher aside and writes the
// wrapper. The paths and script text are domain/hooks/codex-wrapper.ts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../base/util/atomic-write.js';
import { envPath } from '../../base/util/env.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../base/util/json.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';
import {
  CODEX_LAUNCHER_NAMES,
  codexLauncherWrapperText,
  installResult,
  namesInstallerPaths,
  pathEquals,
  repairRefusal,
  resolveCodexInstallPlan,
  resolveCodexWrapperPaths,
  resolveHippoCliPath,
  type CodexWrapperInstallResult,
  type CodexWrapperMetadata,
  type CodexWrapperPaths,
  type EnsureCodexWrapperResult,
} from '../../domain/hooks/codex-wrapper.js';
import { HIPPO_CODEX_WRAPPER_MARKER } from '../../domain/hooks/shared.js';

// The installer module exposes the paths it installs to.
export { resolveCodexWrapperPaths } from '../../domain/hooks/codex-wrapper.js';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const METADATA_TEXT_FIELDS = [
  'originalCodexPath',
  'realCodexPath',
  'commandPath',
  'backupPath',
  'logFile',
  'installedAt',
] as const;

/** The check at the parse site; whether the paths are the installer's own is isCodexWrapperMetadataValid's. */
function isCodexWrapperMetadataRecord(value: JsonValue): value is JsonValue & CodexWrapperMetadata {
  if (!isJsonObject(value)) return false;
  if (!METADATA_TEXT_FIELDS.every((field) => isJsonString(value[field]))) return false;
  if (value['installMode'] !== 'same-path' && value['installMode'] !== 'cmd-shim') return false;
  return value['hippoCliPath'] === undefined || isJsonString(value['hippoCliPath']);
}

function readCodexWrapperMetadata(): CodexWrapperMetadata | null {
  const { metadataPath } = resolveCodexWrapperPaths();
  if (!fs.existsSync(metadataPath)) return null;
  try {
    const parsed: JsonValue = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (isCodexWrapperMetadataRecord(parsed)) return parsed;
    log.warn(`codex wrapper metadata ${metadataPath} has the wrong shape; it is ignored`);
    return null;
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

function isCodexWrapperMetadataValid(metadata: CodexWrapperMetadata | null): metadata is CodexWrapperMetadata {
  if (!metadata) return false;
  return (
    namesInstallerPaths(metadata) &&
    fs.existsSync(metadata.realCodexPath) &&
    fs.existsSync(metadata.backupPath) &&
    isHippoCodexWrapperFile(metadata.commandPath)
  );
}

function writeCodexLauncherWrapper(commandPath: string): void {
  writeExecutableFile(commandPath, codexLauncherWrapperText(commandPath, process.execPath, resolveHippoCliPath()));
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

/** Wrapper metadata on this machine means the user opted in once, via `hippo hook install codex`. */
export function isCodexWrapperInstalled(): boolean {
  return readCodexWrapperMetadata() !== null;
}

/** Re-ensures the wrapper only where its metadata, the user's opt-in record, exists: replacing another vendor's binary
 * without `hippo hook install codex` breaks consent and reads as hijacking to security scanners. */
export function repairCodexWrapperIfInstalled(hippoCliPath: string = resolveHippoCliPath()): EnsureCodexWrapperResult {
  const metadata = readCodexWrapperMetadata();
  if (metadata === null) {
    return { status: 'not-found' };
  }
  const refusal = repairRefusal(metadata, hippoCliPath);
  return refusal === null ? ensureCodexWrapperInstalled() : { status: refusal };
}
