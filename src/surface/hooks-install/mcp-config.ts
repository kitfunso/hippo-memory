import * as fs from 'node:fs';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { isFileSystemError } from '../../base/util/expected-errors.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { Homes } from '../../base/util/agent-homes.js';
import { tryParseJson, type JsonValue } from '../../base/util/json.js';
import { grokStatus, planGrokInstall, planGrokRemoval } from './rules/grok-build.js';
import {
  addHippoServer,
  hasConflictingServerKeys,
  hippoCommand,
  jsonText,
  jsonTextStyle,
  mcpConfigOf,
  removeHippoServer,
  type McpConfig,
  type McpConfigFormat,
  type McpConfigHost,
  type McpConfigRow,
  type McpFailure,
  type McpMergeStatus,
  type McpRemoveStatus,
} from './rules/mcp-config.js';

export interface McpConfigInstallResult {
  readonly name: string;
  readonly file: string;
  readonly status: McpMergeStatus | McpFailure;
}

export interface McpConfigUninstallResult {
  readonly name: string;
  readonly file: string;
  readonly status: McpRemoveStatus | McpFailure;
}

function readText(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

function readMcpConfig(
  text: string | null,
  host: McpConfigHost,
): McpConfig | 'conflicting-keys' | null {
  let config: JsonValue = host.seed?.() ?? {};
  if (text !== null) {
    const parsed = tryParseJson(jsonTextStyle(text).bom ? text.slice(1) : text);
    if (parsed !== undefined) config = parsed;
    else if (text.trim() !== '') return null;
  }
  if (hasConflictingServerKeys(config, host)) return 'conflicting-keys';
  return mcpConfigOf(config, host);
}

export function mergeMcpServer(file: string, host: McpConfigHost): McpMergeStatus {
  const text = readText(file);
  const read = readMcpConfig(text, host);
  if (read === null) return 'unreadable';
  if (read === 'conflicting-keys') return read;
  const status = addHippoServer(read, host);
  if (status !== 'added') return status;
  if ((host.invalid?.(read.config) ?? null) !== null) return 'invalid';
  writeFileAtomic(file, jsonText(read.config, jsonTextStyle(text)));
  return status;
}

export function removeMcpServer(file: string, host: McpConfigHost): McpRemoveStatus {
  const text = readText(file);
  if (text === null) return 'absent';
  const read = readMcpConfig(text, host);
  if (read === null) return 'unreadable';
  if (read === 'conflicting-keys') return read;
  const status = removeHippoServer(read, host);
  if (status === 'removed') writeFileAtomic(file, jsonText(read.config, jsonTextStyle(text)));
  return status;
}

export function mcpStep<S>(step: () => S): S | McpFailure {
  try {
    return step();
  } catch (err) {
    if (isFileSystemError(err)) return { failed: err.message };
    throw err;
  }
}

function mergeGrokBlock(file: string): McpMergeStatus {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const status = grokStatus(text);
  if (status !== 'absent') return status;
  writeFileAtomic(file, planGrokInstall(text, hippoCommand()));
  return 'added';
}

function removeGrokBlock(file: string): McpRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const text = fs.readFileSync(file, 'utf8');
  const next = planGrokRemoval(text);
  if (next !== null) {
    writeFileAtomic(file, next);
    return 'removed';
  }
  const status = grokStatus(text);
  return status === 'present' ? 'absent' : status;
}

function mergeInFormat(file: string, format: McpConfigFormat): McpMergeStatus {
  return format.kind === 'json' ? mergeMcpServer(file, format.host) : mergeGrokBlock(file);
}

function removeInFormat(file: string, format: McpConfigFormat): McpRemoveStatus {
  return format.kind === 'json' ? removeMcpServer(file, format.host) : removeGrokBlock(file);
}

function isFolder(dir: string): boolean {
  try {
    return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (err) {
    if (!isFileSystemError(err)) throw err;
    log.warn(
      `could not check the folder ${dir}, so hippo counts it as missing: ${errorMessage(err)}`,
      errorFields(err),
    );
    return false;
  }
}

export function isMcpConfigHostPresent(row: McpConfigRow, homes: Homes): boolean {
  return row.dirs(homes).some(isFolder);
}

export function installMcpConfigHost(row: McpConfigRow, homes: Homes): McpConfigInstallResult {
  const file = row.file(homes);
  return { name: row.name, file, status: mcpStep(() => mergeInFormat(file, row.format)) };
}

export function uninstallMcpConfigHost(row: McpConfigRow, homes: Homes): McpConfigUninstallResult {
  const file = row.file(homes);
  return { name: row.name, file, status: mcpStep(() => removeInFormat(file, row.format)) };
}
