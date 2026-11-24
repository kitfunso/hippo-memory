import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  type ConfigFile,
  type HippoConfig,
  type RuntimeSettings,
} from '../base/config/config.js';
import { configOverDefaults } from '../base/config/config-keys.js';
import { isJsonObject, type JsonValue } from '../base/util/json.js';
import { errorCode, errorFields, errorMessage, log } from '../base/util/log.js';
import { realpathOrResolve } from './real-path.js';

/** Reads the folder's config.json on every call; a root that loads often holds a configReader
 * instead. */
export function loadConfig(hippoRoot: string): HippoConfig {
  if (hippoRoot === '') return { ...DEFAULT_CONFIG };
  const configPath = path.join(hippoRoot, 'config.json');
  return fileStamp(configPath) === null ? { ...DEFAULT_CONFIG } : parseConfigFile(configPath);
}

/** Whether the store's config names projects by their origin remote; a project walk asks the
 * global store's. */
export function namesProjectsByRemote(hippoRoot: string): boolean {
  return loadConfig(hippoRoot).projectIdentity.remote;
}

export type ConfigReader = (hippoRoot: string) => HippoConfig;

const PARSED_CONFIGS_MAX = 64;

/** A loadConfig whose parses belong to the root that made it, so two servers in one process
 * never share one. `runtime` is the root's environment read, taken on each call so every command
 * or request sees the current one. */
export function configReader(runtime?: () => RuntimeSettings): ConfigReader {
  const parsed = new Map<string, { stamp: string | null; config: HippoConfig }>();
  const read = (hippoRoot: string): HippoConfig => {
    if (hippoRoot === '') return { ...DEFAULT_CONFIG };
    const configPath = path.join(hippoRoot, 'config.json');
    const key = path.resolve(configPath);
    const stamp = fileStamp(configPath);
    const hit = parsed.get(key);
    if (hit !== undefined && hit.stamp === stamp) return { ...hit.config };
    const config = stamp === null ? DEFAULT_CONFIG : parseConfigFile(configPath);
    if (parsed.size >= PARSED_CONFIGS_MAX) parsed.clear();
    parsed.set(key, { stamp, config });
    return { ...config };
  };
  return runtime === undefined ? read : (hippoRoot) => ({ ...read(hippoRoot), runtime: runtime() });
}

function fileStamp(file: string): string | null {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat === undefined ? null : `${stat.mtimeMs}:${stat.size}`;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `${file} could not be reached (${code}): ${errorMessage(err)}. ` +
          `Fix the permissions on the file and its folder, or delete the file to use the defaults.`,
        { cause: err },
      );
    }
    log.debug(
      `config: ${file} is not reachable, read as missing: ${errorMessage(err)}`,
      errorFields(err),
    );
    return null;
  }
}

function readConfigFile(configPath: string): ConfigFile {
  let raw: JsonValue;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `${configPath} could not be loaded: ${errorMessage(err)}. Fix the file or delete it to use the defaults.`,
      { cause: err },
    );
  }
  if (!isJsonObject(raw)) {
    throw new Error(
      `${configPath} must hold a JSON object. Fix the file or delete it to use the defaults.`,
    );
  }
  return raw;
}

function parseConfigFile(configPath: string): HippoConfig {
  return configOverDefaults(readConfigFile(configPath));
}

/** True when the store's config.json sets `"sharedStore": true`, read on each call. Reads only
 * this key, so loadConfig's warnings stay loadConfig's. A root holds a Host, whose check stays
 * true once true. */
export function isSharedStore(hippoRoot: string): boolean {
  const configPath = path.join(path.resolve(hippoRoot), 'config.json');
  return fileStamp(configPath) !== null && readConfigFile(configPath).sharedStore === true;
}

/** An isSharedStore whose answers belong to its maker: a root read as shared stays shared, so a
 * broken edit while a server runs cannot turn it off, and an unchanged file read as not shared
 * is not parsed again. */
export function sharedStoreCheck(): (hippoRoot: string) => boolean {
  const sharedRoots = new Set<string>();
  const notSharedStamps = new Map<string, string>();
  return (hippoRoot) => {
    const real = realpathOrResolve(hippoRoot);
    const key = process.platform === 'win32' ? real.toLowerCase() : real;
    if (sharedRoots.has(key)) return true;
    const configPath = path.join(path.resolve(hippoRoot), 'config.json');
    const stamp = fileStamp(configPath);
    if (stamp === null || notSharedStamps.get(configPath) === stamp) return false;
    if (readConfigFile(configPath).sharedStore !== true) {
      if (notSharedStamps.size >= PARSED_CONFIGS_MAX) notSharedStamps.clear();
      notSharedStamps.set(configPath, stamp);
      return false;
    }
    sharedRoots.add(key);
    return true;
  };
}
