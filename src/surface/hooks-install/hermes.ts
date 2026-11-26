import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermesHomeDir, userHome, type Homes } from '../../base/util/agent-homes.js';
import { isFileSystemError } from '../../base/util/expected-errors.js';
import { isJsonObject, isJsonString, tryParseJson } from '../../base/util/json.js';
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

function installIntoDir(pluginDir: string): HermesInstallStatus {
  const state = pluginDirState(pluginDir);
  if (state === 'not-dir') return { failed: `${pluginDir} is not a directory` };
  const sources = loadPackageSources();
  if (state === 'missing') {
    for (const file of sources.files) {
      writeFileAtomic(path.join(pluginDir, file.name), file.content);
    }
    writeLauncher(pluginDir, sources);
    return 'installed';
  }
  const record = readLauncherRecord(path.join(pluginDir, LAUNCHER_NAME));
  if (record === null) return 'user-owned';
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
  for (const file of differing) writeFileAtomic(path.join(pluginDir, file.name), file.content);
  writeLauncher(pluginDir, sources);
  return 'updated';
}

function removeFromDir(pluginDir: string): HermesUninstallStatus {
  const state = pluginDirState(pluginDir);
  if (state === 'missing') return 'absent';
  if (state === 'not-dir') return { failed: `${pluginDir} is not a directory` };
  const record = readLauncherRecord(path.join(pluginDir, LAUNCHER_NAME));
  if (record === null) return 'user-owned';
  const sources = loadPackageSources();
  if (hasHandEdits(diskHashes(pluginDir), record, sources)) return 'kept';
  for (const name of [...PLUGIN_FILES, LAUNCHER_NAME]) {
    const file = path.join(pluginDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  const pycache = path.join(pluginDir, '__pycache__');
  if (fs.lstatSync(pycache, { throwIfNoEntry: false })?.isDirectory()) {
    fs.rmSync(pycache, { recursive: true, force: true });
  }
  if (fs.readdirSync(pluginDir).length === 0) fs.rmdirSync(pluginDir);
  return 'removed';
}

export function hermesPluginPaths(homes: Homes = processHomes()): HermesPluginPaths {
  const { home, profile } = hermesHomeDir(
    userHome(homes),
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
