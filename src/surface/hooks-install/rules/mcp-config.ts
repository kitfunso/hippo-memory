import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import { userHome, type Homes } from '../../../base/util/agent-homes.js';
import { type JsonValue, isJsonObjectLiteral, type JsonObject } from '../../../base/util/json.js';

const MCP_KEY = 'hippo';

export interface McpConfigHost {
  readonly key: 'mcpServers' | 'servers' | 'mcp_servers';
  seed?(): JsonObject;
  server(): JsonObject;
}

export function hippoCommand(): string {
  return process.platform === 'win32' ? 'hippo.cmd' : 'hippo';
}

export const JUNIE_MCP: McpConfigHost = {
  key: 'mcpServers',
  server: () => ({ command: hippoCommand(), args: ['mcp'] }),
};

export const ANTIGRAVITY_MCP: McpConfigHost = {
  key: 'mcpServers',
  server: () => ({ command: hippoCommand(), args: ['mcp'] }),
};

export const MUSE_CODE_MCP: McpConfigHost = {
  key: 'mcp_servers',
  seed: () => ({ schema_version: 1 }),
  server: () => ({ transport: 'stdio', command: hippoCommand(), args: ['mcp'], mode: 'optional' }),
};

function isHipposServer(entry: JsonValue | undefined, host: McpConfigHost): boolean {
  if (!isJsonObjectLiteral(entry) || !('command' in entry) || !('args' in entry)) return false;
  const ours = host.server();
  return Object.entries(entry).every(([key, value]) =>
    key === 'command'
      ? value === 'hippo' || value === 'hippo.cmd'
      : isDeepStrictEqual(value, ours[key]),
  );
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

export type McpMergeStatus = 'added' | 'present' | 'user-owned' | 'unreadable';

export function addHippoServer(
  read: McpConfig,
  host: McpConfigHost,
): Exclude<McpMergeStatus, 'unreadable'> {
  const existing = read.servers[MCP_KEY];
  if (existing !== undefined) return isHipposServer(existing, host) ? 'present' : 'user-owned';
  read.servers[MCP_KEY] = host.server();
  return 'added';
}

export type McpRemoveStatus = 'removed' | 'absent' | 'user-owned' | 'unreadable';

export function removeHippoServer(
  read: McpConfig,
  host: McpConfigHost,
): Exclude<McpRemoveStatus, 'unreadable'> {
  const existing = read.servers[MCP_KEY];
  if (existing === undefined) return 'absent';
  if (!isHipposServer(existing, host)) return 'user-owned';
  delete read.servers[MCP_KEY];
  if (Object.keys(read.servers).length === 0) delete read.config[host.key];
  return 'removed';
}

export interface McpFailure {
  readonly failed: string;
}

export function isMcpFailure(status: string | McpFailure): status is McpFailure {
  return typeof status !== 'string';
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
    dirs: (homes) => [path.join(userHome(homes), '.grok')],
    file: (homes) => path.join(userHome(homes), '.grok', 'config.toml'),
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
