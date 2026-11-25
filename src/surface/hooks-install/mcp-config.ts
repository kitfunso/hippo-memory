import * as fs from 'node:fs';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { isFileSystemError } from '../../base/util/expected-errors.js';
import type { Homes } from '../../base/util/agent-homes.js';
import { type JsonValue } from '../../base/util/json.js';
import { readJsonFile } from '../../host/json-file.js';
import { grokStatus, planGrokInstall, planGrokRemoval } from './rules/grok-build.js';
import {
  addHippoServer,
  hippoCommand,
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
import { writeSettingsFile } from './json-hooks.js';

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

export function readMcpConfig(file: string, host: McpConfigHost): McpConfig | null {
  let config: JsonValue = host.seed?.() ?? {};
  if (fs.existsSync(file)) {
    try {
      config = readJsonFile(file);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      if (fs.readFileSync(file, 'utf8').trim() !== '') return null;
    }
  }
  return mcpConfigOf(config, host);
}

export function mergeMcpServer(file: string, host: McpConfigHost): McpMergeStatus {
  const read = readMcpConfig(file, host);
  if (read === null) return 'unreadable';
  const status = addHippoServer(read, host);
  if (status === 'added') writeSettingsFile(file, read.config);
  return status;
}

export function removeMcpServer(file: string, host: McpConfigHost): McpRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const read = readMcpConfig(file, host);
  if (read === null) return 'unreadable';
  const status = removeHippoServer(read, host);
  if (status === 'removed') writeSettingsFile(file, read.config);
  return status;
}

export function mcpStep<S extends string>(step: () => S): S | McpFailure {
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
  return grokStatus(text) === 'user-owned' ? 'user-owned' : 'absent';
}

function mergeInFormat(file: string, format: McpConfigFormat): McpMergeStatus {
  return format.kind === 'json' ? mergeMcpServer(file, format.host) : mergeGrokBlock(file);
}

function removeInFormat(file: string, format: McpConfigFormat): McpRemoveStatus {
  return format.kind === 'json' ? removeMcpServer(file, format.host) : removeGrokBlock(file);
}

export function isMcpConfigHostPresent(row: McpConfigRow, homes: Homes): boolean {
  return row
    .dirs(homes)
    .some((dir) => fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);
}

export function installMcpConfigHost(row: McpConfigRow, homes: Homes): McpConfigInstallResult {
  const file = row.file(homes);
  return { name: row.name, file, status: mcpStep(() => mergeInFormat(file, row.format)) };
}

export function uninstallMcpConfigHost(row: McpConfigRow, homes: Homes): McpConfigUninstallResult {
  const file = row.file(homes);
  return { name: row.name, file, status: mcpStep(() => removeInFormat(file, row.format)) };
}
