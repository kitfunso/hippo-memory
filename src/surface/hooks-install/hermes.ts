import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesHomeDir, userHome, type Homes } from '../../base/util/agent-homes.js';
import { isFileSystemError } from '../../base/util/expected-errors.js';
import { isJsonObject, isJsonString, tryParseJson } from '../../base/util/json.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { processHomes } from '../../host/agent-homes.js';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { diskAgentFiles } from '../../infra/agent-files.js';

const PLUGIN_FILES = ['__init__.py', 'plugin.yaml', 'README.md'] as const;
type PluginFile = (typeof PLUGIN_FILES)[number];

const LAUNCHER_NAME = 'launcher.json';
const MANAGED_BY = 'hippo-memory';

export interface HermesPluginPaths {
  readonly home: string;
  readonly profile: string | null;
  readonly pluginDir: string;
}

export interface HermesFailure {
  readonly failed: string;
}

export type HermesInstallStatus =
  | 'installed'
  | 'updated'
  | 'present'
  | 'no-home'
  | 'user-owned'
  | 'kept'
  | HermesFailure;

export interface HermesInstallResult extends HermesPluginPaths {
  readonly status: HermesInstallStatus;
}

export type HermesUninstallStatus = 'removed' | 'absent' | 'user-owned' | 'kept' | HermesFailure;

export interface HermesUninstallResult extends HermesPluginPaths {
  readonly status: HermesUninstallStatus;
}

interface LauncherRecord {
  readonly managedBy: string;
  readonly node: string;
  readonly script: string;
  readonly hashes: ReadonlyMap<PluginFile, string>;
}

interface SourceFile {
  readonly name: PluginFile;
  readonly content: Buffer;
  readonly hash: string;
}

interface PackageSources {
  readonly script: string;
  readonly files: readonly SourceFile[];
  readonly hashes: Readonly<Record<PluginFile, string>>;
}

export function isHermesFailure(
  status: HermesInstallStatus | HermesUninstallStatus,
): status is HermesFailure {
  return typeof status === 'object' && 'failed' in status;
}

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('hippo package.json not found');
    dir = parent;
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function loadPackageSources(): PackageSources {
  const root = packageRoot();
  const srcDir = path.join(root, 'extensions', 'hermes-memory-provider', 'hippo');
  const read = (name: PluginFile): SourceFile => {
    const content = fs.readFileSync(path.join(srcDir, name));
    return { name, content, hash: sha256(content) };
  };
  const init = read('__init__.py');
  const yaml = read('plugin.yaml');
  const readme = read('README.md');
  return {
    script: path.join(root, 'bin', 'hippo.js'),
    files: [init, yaml, readme],
    hashes: { '__init__.py': init.hash, 'plugin.yaml': yaml.hash, 'README.md': readme.hash },
  };
}

function readLauncherRecord(file: string): LauncherRecord | null {
  if (!fs.existsSync(file)) return null;
  const parsed = tryParseJson(fs.readFileSync(file, 'utf8'));
  if (!isJsonObject(parsed) || parsed.managedBy !== MANAGED_BY) return null;
  const hashes = new Map<PluginFile, string>();
  if (isJsonObject(parsed.hashes)) {
    for (const name of PLUGIN_FILES) {
      const hash = parsed.hashes[name];
      if (isJsonString(hash)) hashes.set(name, hash);
    }
  }
  return {
    managedBy: MANAGED_BY,
    node: isJsonString(parsed.node) ? parsed.node : '',
    script: isJsonString(parsed.script) ? parsed.script : '',
    hashes,
  };
}

function pluginDirState(pluginDir: string): 'missing' | 'dir' | 'not-dir' {
  const stat = fs.lstatSync(pluginDir, { throwIfNoEntry: false });
  if (stat === undefined) return 'missing';
  return stat.isDirectory() ? 'dir' : 'not-dir';
}

function diskHashes(pluginDir: string): Map<PluginFile, string> {
  const out = new Map<PluginFile, string>();
  for (const name of PLUGIN_FILES) {
    const file = path.join(pluginDir, name);
    if (fs.existsSync(file)) out.set(name, sha256(fs.readFileSync(file)));
  }
  return out;
}

function hasHandEdits(
  onDisk: ReadonlyMap<PluginFile, string>,
  record: LauncherRecord,
  sources: PackageSources,
): boolean {
  return PLUGIN_FILES.some((name) => {
    const current = onDisk.get(name);
    return (
      current !== undefined &&
      current !== record.hashes.get(name) &&
      current !== sources.hashes[name]
    );
  });
}

function writeLauncher(pluginDir: string, sources: PackageSources): void {
  const payload = {
    managedBy: MANAGED_BY,
    node: process.execPath,
    script: sources.script,
    hashes: sources.hashes,
  };
  writeFileAtomic(path.join(pluginDir, LAUNCHER_NAME), `${JSON.stringify(payload, null, 2)}\n`);
}

function checkManagedEntries(pluginDir: string): HermesFailure | null {
  for (const name of [...PLUGIN_FILES, LAUNCHER_NAME]) {
    const file = path.join(pluginDir, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat !== undefined && !stat.isFile()) {
      return { failed: `${file} is not a regular file` };
    }
  }
  return null;
}

function stageFreshInstall(pluginDir: string, sources: PackageSources): void {
  const parent = path.dirname(pluginDir);
  fs.mkdirSync(parent, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(parent, '.hippo-install-'));
  try {
    for (const file of sources.files) {
      writeFileAtomic(path.join(stageDir, file.name), file.content);
    }
    writeLauncher(stageDir, sources);
    fs.renameSync(stageDir, pluginDir);
  } catch (err) {
    fs.rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}

function upgradeDir(
  pluginDir: string,
  differing: readonly SourceFile[],
  sources: PackageSources,
): void {
  const backups = differing.map((file) => {
    const dest = path.join(pluginDir, file.name);
    return { dest, prev: fs.existsSync(dest) ? fs.readFileSync(dest) : null };
  });
  const written: { readonly dest: string; readonly prev: Buffer | null }[] = [];
  try {
    for (let i = 0; i < differing.length; i++) {
      writeFileAtomic(backups[i].dest, differing[i].content);
      written.push(backups[i]);
    }
    writeLauncher(pluginDir, sources);
  } catch (err) {
    for (const item of written.reverse()) {
      try {
        if (item.prev === null) fs.rmSync(item.dest, { force: true });
        else writeFileAtomic(item.dest, item.prev);
      } catch (rollbackErr) {
        log.warn(
          `hermes upgrade rollback failed for ${item.dest}: ${errorMessage(rollbackErr)}`,
          errorFields(rollbackErr),
        );
      }
    }
    throw err;
  }
}

function hasManagedEntry(pluginDir: string): boolean {
  return [...PLUGIN_FILES, LAUNCHER_NAME].some(
    (name) => fs.lstatSync(path.join(pluginDir, name), { throwIfNoEntry: false }) !== undefined,
  );
}

function removeManagedFiles(pluginDir: string): void {
  const targets = [...PLUGIN_FILES, LAUNCHER_NAME]
    .map((name) => path.join(pluginDir, name))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, content: fs.readFileSync(file) }));
  const removed: { readonly file: string; readonly content: Buffer }[] = [];
  try {
    for (const item of targets) {
      fs.unlinkSync(item.file);
      removed.push(item);
    }
  } catch (err) {
    for (const item of removed.reverse()) {
      try {
        writeFileAtomic(item.file, item.content);
      } catch (rollbackErr) {
        log.warn(
          `hermes uninstall rollback failed for ${item.file}: ${errorMessage(rollbackErr)}`,
          errorFields(rollbackErr),
        );
      }
    }
    throw err;
  }
}

function removeHippoPycache(pluginDir: string): void {
  const pycache = path.join(pluginDir, '__pycache__');
  if (!fs.lstatSync(pycache, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const name of fs.readdirSync(pycache)) {
    if (!/^__init__\..*\.pyc$/i.test(name)) continue;
    const file = path.join(pycache, name);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(file);
  }
  if (fs.readdirSync(pycache).length === 0) fs.rmdirSync(pycache);
}

function installIntoDir(pluginDir: string): HermesInstallStatus {
  const state = pluginDirState(pluginDir);
  if (state === 'not-dir') return { failed: `${pluginDir} is not a directory` };
  const sources = loadPackageSources();
  if (state === 'missing') {
    stageFreshInstall(pluginDir, sources);
    return 'installed';
  }
  const badEntry = checkManagedEntries(pluginDir);
  if (badEntry !== null) return badEntry;
  const record = readLauncherRecord(path.join(pluginDir, LAUNCHER_NAME));
  if (record === null) {
    if (hasManagedEntry(pluginDir)) return 'user-owned';
    upgradeDir(pluginDir, sources.files, sources);
    return 'installed';
  }
  const onDisk = diskHashes(pluginDir);
  if (hasHandEdits(onDisk, record, sources)) return 'kept';
  const differing = sources.files.filter((file) => onDisk.get(file.name) !== file.hash);
  const hashesMatch = PLUGIN_FILES.every(
    (name) => record.hashes.get(name) === sources.hashes[name],
  );
  if (
    differing.length === 0 &&
    hashesMatch &&
    record.node === process.execPath &&
    record.script === sources.script
  ) {
    return 'present';
  }
  upgradeDir(pluginDir, differing, sources);
  return 'updated';
}

function removeFromDir(pluginDir: string): HermesUninstallStatus {
  const state = pluginDirState(pluginDir);
  if (state === 'missing') return 'absent';
  if (state === 'not-dir') return { failed: `${pluginDir} is not a directory` };
  const badEntry = checkManagedEntries(pluginDir);
  if (badEntry !== null) return badEntry;
  const record = readLauncherRecord(path.join(pluginDir, LAUNCHER_NAME));
  if (record === null) return 'user-owned';
  const sources = loadPackageSources();
  if (hasHandEdits(diskHashes(pluginDir), record, sources)) return 'kept';
  removeManagedFiles(pluginDir);
  removeHippoPycache(pluginDir);
  if (fs.readdirSync(pluginDir).length === 0) fs.rmdirSync(pluginDir);
  return 'removed';
}

function hermesUserHome(homes: Homes): string {
  return process.platform === 'win32' ? homes.env.USERPROFILE || homes.home : userHome(homes);
}

export function hermesPluginPaths(homes: Homes = processHomes()): HermesPluginPaths {
  const { home, profile } = hermesHomeDir(
    hermesUserHome(homes),
    homes.env,
    process.platform,
    diskAgentFiles,
  );
  return { home, profile, pluginDir: path.join(home, 'plugins', 'hippo') };
}

export function isHermesPresent(homes: Homes = processHomes()): boolean {
  const { home } = hermesPluginPaths(homes);
  try {
    return fs.statSync(home, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (err) {
    if (!isFileSystemError(err)) throw err;
    return false;
  }
}

export function installHermes(homes: Homes = processHomes()): HermesInstallResult {
  const paths = hermesPluginPaths(homes);
  if (!isHermesPresent(homes)) return { status: 'no-home', ...paths };
  try {
    return { status: installIntoDir(paths.pluginDir), ...paths };
  } catch (err) {
    if (isFileSystemError(err)) return { status: { failed: err.message }, ...paths };
    throw err;
  }
}

export function uninstallHermes(homes: Homes = processHomes()): HermesUninstallResult {
  const paths = hermesPluginPaths(homes);
  try {
    return { status: removeFromDir(paths.pluginDir), ...paths };
  } catch (err) {
    if (isFileSystemError(err)) return { status: { failed: err.message }, ...paths };
    throw err;
  }
}
