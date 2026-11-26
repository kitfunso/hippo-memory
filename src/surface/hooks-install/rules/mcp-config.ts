import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import { userHome, type Homes } from '../../../base/util/agent-homes.js';
import {
  type JsonValue,
  isJsonObjectLiteral,
  isJsonString,
  type JsonObject,
} from '../../../base/util/json.js';

const MCP_KEY = 'hippo';
const HIPPO_PACKAGE = 'hippo-memory';
const BOM = '\uFEFF';

export interface McpConfigHost {
  readonly key: 'mcpServers' | 'servers' | 'mcp_servers';
  readonly subsetMatch?: true;
  seed?(): JsonObject;
  server(): JsonObject;
  readonly invalid?: (config: JsonObject) => string | null;
}

export function hippoCommand(): string {
  return process.platform === 'win32' ? 'hippo.cmd' : 'hippo';
}

const JUNIE_MCP: McpConfigHost = {
  key: 'mcpServers',
  server: () => ({ command: hippoCommand(), args: ['mcp'] }),
};

const ANTIGRAVITY_MCP: McpConfigHost = {
  key: 'mcpServers',
  server: () => ({ command: hippoCommand(), args: ['mcp'] }),
};

const MUSE_NEEDS_SCHEMA = 'has no "schema_version", which Muse Code needs; add "schema_version": 1';

const MUSE_CODE_MCP: McpConfigHost = {
  key: 'mcp_servers',
  seed: () => ({ schema_version: 1 }),
  server: () => ({ transport: 'stdio', command: hippoCommand(), args: ['mcp'], mode: 'optional' }),
  invalid: (config) => (config.schema_version === undefined ? MUSE_NEEDS_SCHEMA : null),
};

function hasKeysOf(entry: JsonObject, ours: JsonObject): boolean {
  const keys = Object.keys(entry);
  const ourKeys = Object.keys(ours);
  return keys.length === ourKeys.length && keys.every((key) => ourKeys.includes(key));
}

function isHipposServer(entry: JsonValue | undefined, host: McpConfigHost): boolean {
  if (!isJsonObjectLiteral(entry) || !('command' in entry) || !('args' in entry)) return false;
  const ours = host.server();
  if (host.subsetMatch !== true && !hasKeysOf(entry, ours)) return false;
  return Object.entries(entry).every(([key, value]) =>
    key === 'command'
      ? value === 'hippo' || value === 'hippo.cmd'
      : isDeepStrictEqual(value, ours[key]),
  );
}

function commandName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(?:cmd|exe|ps1)$/, '');
}

export function runsHippoMcp(command: string, args: readonly string[]): boolean {
  return commandName(command) === 'hippo' && args.length === 1 && args[0] === 'mcp';
}

export function npxMentionsHippo(command: string, args: readonly string[]): boolean {
  return commandName(command) === 'npx' && args.some((arg) => arg.includes(HIPPO_PACKAGE));
}

function entryCommandAndArgs(
  entry: JsonValue | undefined,
): { readonly command: string; readonly args: readonly string[] } | null {
  if (!isJsonObjectLiteral(entry)) return null;
  const { command, args } = entry;
  if (!isJsonString(command) || !Array.isArray(args) || !args.every(isJsonString)) return null;
  return { command, args };
}

function entryRunsHippoMcp(entry: JsonValue | undefined): boolean {
  const pair = entryCommandAndArgs(entry);
  return pair !== null && runsHippoMcp(pair.command, pair.args);
}

function entryMayRunHippo(entry: JsonValue | undefined): boolean {
  const pair = entryCommandAndArgs(entry);
  return pair !== null && npxMentionsHippo(pair.command, pair.args);
}

export function mcpServerSnippet(host: McpConfigHost): string {
  return `"${MCP_KEY}": ${JSON.stringify(host.server())}`;
}

export interface McpConfig {
  readonly config: JsonObject;
  readonly servers: JsonObject;
}

export function mcpConfigOf(config: JsonValue, host: McpConfigHost): McpConfig | null {
  if (!isJsonObjectLiteral(config)) return null;
  if (config[host.key] === undefined) config[host.key] = {};
  const servers = config[host.key];
  return isJsonObjectLiteral(servers) ? { config, servers } : null;
}

export interface McpMaybeHippo {
  readonly maybeHippo: string;
}

export type McpMergeStatus =
  | 'added'
  | 'present'
  | 'kept'
  | 'user-owned'
  | 'unreadable'
  | 'invalid'
  | McpMaybeHippo;

export function addHippoServer(
  read: McpConfig,
  host: McpConfigHost,
): Exclude<McpMergeStatus, 'unreadable' | 'invalid'> {
  const existing = read.servers[MCP_KEY];
  if (existing !== undefined) {
    if (isHipposServer(existing, host)) return 'present';
    if (entryRunsHippoMcp(existing)) return 'kept';
    if (entryMayRunHippo(existing)) return { maybeHippo: MCP_KEY };
    return 'user-owned';
  }
  if (Object.values(read.servers).some(entryRunsHippoMcp)) return 'kept';
  const maybe = Object.entries(read.servers).find(([, entry]) => entryMayRunHippo(entry));
  if (maybe !== undefined) return { maybeHippo: maybe[0] };
  read.servers[MCP_KEY] = host.server();
  return 'added';
}

export type McpRemoveStatus =
  | 'removed'
  | 'absent'
  | 'kept'
  | 'user-owned'
  | 'unreadable'
  | McpMaybeHippo;

export function removeHippoServer(
  read: McpConfig,
  host: McpConfigHost,
): Exclude<McpRemoveStatus, 'unreadable'> {
  const existing = read.servers[MCP_KEY];
  if (existing === undefined) {
    if (Object.values(read.servers).some(entryRunsHippoMcp)) return 'kept';
    const maybe = Object.entries(read.servers).find(([, entry]) => entryMayRunHippo(entry));
    return maybe !== undefined ? { maybeHippo: maybe[0] } : 'absent';
  }
  if (!isHipposServer(existing, host)) {
    if (entryRunsHippoMcp(existing)) return 'kept';
    return entryMayRunHippo(existing) ? { maybeHippo: MCP_KEY } : 'user-owned';
  }
  delete read.servers[MCP_KEY];
  if (Object.keys(read.servers).length === 0) delete read.config[host.key];
  return 'removed';
}

export interface JsonTextStyle {
  readonly bom: boolean;
  readonly eol: string;
  readonly indent: string;
  readonly finalEol: boolean;
}

export function jsonTextStyle(text: string | null): JsonTextStyle {
  const source = text ?? '';
  return {
    bom: source.startsWith(BOM),
    eol: /\r?\n/.exec(source)?.[0] === '\r\n' ? '\r\n' : '\n',
    indent: /^[ \t]+(?=\S)/m.exec(source)?.[0] ?? '  ',
    finalEol: source.trim() === '' || /[\r\n]$/.test(source),
  };
}

export function jsonText(value: JsonValue, style: JsonTextStyle): string {
  const body = JSON.stringify(value, null, style.indent).replace(/\n/g, style.eol);
  return `${style.bom ? BOM : ''}${body}${style.finalEol ? style.eol : ''}`;
}

export interface McpFailure {
  readonly failed: string;
}

export function isMcpFailure(status: McpMergeStatus | McpRemoveStatus | McpFailure): status is McpFailure {
  return typeof status === 'object' && status !== null && 'failed' in status;
}

export function isMcpMaybeHippo(
  status: McpMergeStatus | McpRemoveStatus | McpFailure,
): status is McpMaybeHippo {
  return typeof status === 'object' && status !== null && 'maybeHippo' in status;
}

export type McpConfigFormat =
  | { readonly kind: 'json'; readonly host: McpConfigHost }
  | { readonly kind: 'toml-block' };

export interface McpConfigRow {
  readonly name: string;
  readonly label: string;
  readonly dirs: (homes: Homes) => string[];
  readonly file: (homes: Homes) => string;
  readonly format: McpConfigFormat;
}

function grokHome(homes: Homes): string {
  const set = homes.env.GROK_HOME;
  return set !== undefined && set.trim() !== '' ? set : path.join(userHome(homes), '.grok');
}

function museConfigDir(homes: Homes): string {
  return path.join(homes.env.XDG_CONFIG_HOME || path.join(userHome(homes), '.config'), 'muse');
}

export const MCP_CONFIG_HOSTS: readonly McpConfigRow[] = [
  {
    name: 'junie',
    label: 'Junie',
    dirs: (homes) => [path.join(userHome(homes), '.junie')],
    file: (homes) => path.join(userHome(homes), '.junie', 'mcp', 'mcp.json'),
    format: { kind: 'json', host: JUNIE_MCP },
  },
  {
    name: 'antigravity',
    label: 'Antigravity',
    dirs: (homes) => [
      path.join(userHome(homes), '.gemini', 'antigravity'),
      path.join(userHome(homes), '.gemini', 'antigravity-cli'),
    ],
    file: (homes) => path.join(userHome(homes), '.gemini', 'config', 'mcp_config.json'),
    format: { kind: 'json', host: ANTIGRAVITY_MCP },
  },
  {
    name: 'grok-build',
    label: 'Grok Build',
    dirs: (homes) => [grokHome(homes)],
    file: (homes) => path.join(grokHome(homes), 'config.toml'),
    format: { kind: 'toml-block' },
  },
  {
    name: 'muse-code',
    label: 'Muse Code',
    dirs: (homes) => [museConfigDir(homes)],
    file: (homes) => path.join(museConfigDir(homes), 'settings.json'),
    format: { kind: 'json', host: MUSE_CODE_MCP },
  },
];
