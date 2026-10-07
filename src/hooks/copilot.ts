// GitHub Copilot: hippo's hooks file, one MCP server key and an instructions block, all under the Copilot home folder.
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '../working-memory.js';
import { type JsonValue, readJsonFile } from '../json.js';
import { HOOK_MARKERS, hippoBlock, withoutHookBlock } from '../cli/hook-blocks.js';
import { copilotHomeDir, isJsonObject } from './shared.js';
import { installJsonHooks, resolveJsonHookPaths, uninstallJsonHooks, writeSettingsFile } from './json-hooks.js';

const MCP_KEY = 'hippo';

/** Copilot drops what a per-prompt hook prints, so per-task recall goes through the MCP tool the block names. */
export const COPILOT_INSTRUCTIONS = `
## Project Memory (Hippo)

At the start of each task, call the \`hippo_recall\` tool with a short query that
names the task. Read the memories it returns before you write any code.

When you learn something that should outlive this session (a decision and its
reason, a user preference, why something failed), call the \`hippo_remember\`
tool right then, while you work, never as a closing step. Set \`error\` to true
for a failure. Leave out secrets and personal details.

The installed hooks load pinned memories when a session starts, store failed
tool calls and capture the session when it ends, so there is nothing to run
before you finish.
`.trim();

/** The three files hippo writes for Copilot. */
export interface CopilotPaths {
  readonly hooks: string;
  readonly mcpConfig: string;
  readonly instructions: string;
}

export function copilotPaths(): CopilotPaths {
  const home = copilotHomeDir();
  return {
    hooks: resolveJsonHookPaths('copilot').settings,
    mcpConfig: path.join(home, 'mcp-config.json'),
    instructions: path.join(home, 'copilot-instructions.md'),
  };
}

/** Windows gets npm's .cmd shim, as the Codex hooks do, since a PowerShell execution policy can block hippo.ps1. */
function hippoMcpServer(): JsonObject {
  return { type: 'local', command: process.platform === 'win32' ? 'hippo.cmd' : 'hippo', args: ['mcp'], env: {}, tools: ['*'] };
}

/** Only a server hippo wrote counts as hippo's: a user's own "hippo" key with another command or args is never touched. */
function isHipposServer(entry: JsonValue | undefined): boolean {
  return isJsonObject(entry) && (entry.command === 'hippo' || entry.command === 'hippo.cmd') && isDeepStrictEqual(entry.args, ['mcp']);
}

/** What to paste under "mcpServers" when hippo cannot edit the file itself. */
export function copilotMcpSnippet(): string {
  return `"${MCP_KEY}": ${JSON.stringify(hippoMcpServer())}`;
}

interface McpConfig {
  readonly config: JsonObject;
  readonly servers: JsonObject;
}

/** Null for a file with comments, one that is not JSON, or one whose shape a merge would overwrite; a missing file reads as empty. */
function readMcpConfig(file: string): McpConfig | null {
  let config: JsonValue = {};
  if (fs.existsSync(file)) {
    try {
      config = readJsonFile(file);
    } catch {
      return null;
    }
  }
  if (!isJsonObject(config)) return null;
  if (config.mcpServers === undefined) config.mcpServers = {};
  const servers = config.mcpServers;
  return isJsonObject(servers) ? { config, servers } : null;
}

export type McpMergeStatus = 'added' | 'present' | 'user-owned' | 'unreadable';

/** Adds hippo's server and keeps every other key; a file hippo cannot parse, or a "hippo" key it did not write, stays as it is. */
export function mergeMcpServer(file: string): McpMergeStatus {
  const read = readMcpConfig(file);
  if (read === null) return 'unreadable';
  const existing = read.servers[MCP_KEY];
  if (existing !== undefined) return isHipposServer(existing) ? 'present' : 'user-owned';
  read.servers[MCP_KEY] = hippoMcpServer();
  writeSettingsFile(file, read.config);
  return 'added';
}

export type McpRemoveStatus = 'removed' | 'absent' | 'user-owned' | 'unreadable';

/** Removes the "hippo" key only when hippo wrote it. */
export function removeMcpServer(file: string): McpRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const read = readMcpConfig(file);
  if (read === null) return 'unreadable';
  const existing = read.servers[MCP_KEY];
  if (existing === undefined) return 'absent';
  if (!isHipposServer(existing)) return 'user-owned';
  delete read.servers[MCP_KEY];
  if (Object.keys(read.servers).length === 0) delete read.config.mcpServers;
  writeSettingsFile(file, read.config);
  return 'removed';
}

/** Replaces only the text between the markers, in the file's own line ending, or appends a block after the user's text. */
function withCopilotBlock(text: string): string {
  const found = hippoBlock(text);
  if (found !== null) {
    const { start, end, eol } = found;
    return `${text.slice(0, start)}${eol}${COPILOT_INSTRUCTIONS.replace(/\n/g, eol)}${eol}${text.slice(end)}`;
  }
  const block = `${HOOK_MARKERS.start}\n${COPILOT_INSTRUCTIONS}\n${HOOK_MARKERS.end}\n`;
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

/** True when the file changed; creates it when missing. */
export function ensureInstructionsBlock(file: string): boolean {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const next = withCopilotBlock(old);
  if (next === old) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return true;
}

/** True when a block was removed; a file left with nothing else in it goes too. */
export function removeInstructionsBlock(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const old = fs.readFileSync(file, 'utf8');
  if (hippoBlock(old) === null) return false;
  const left = withoutHookBlock(old);
  if (left) fs.writeFileSync(file, left + '\n', 'utf8');
  else fs.rmSync(file);
  return true;
}

export interface CopilotInstallResult {
  readonly paths: CopilotPaths;
  /** True when the hooks file was written; false when it already held hippo's current table. */
  readonly hooks: boolean;
  readonly mcp: McpMergeStatus;
  readonly instructions: boolean;
}

export function installCopilot(): CopilotInstallResult {
  const paths = copilotPaths();
  return {
    paths,
    hooks: installJsonHooks('copilot').installedSessionStart,
    mcp: mergeMcpServer(paths.mcpConfig),
    instructions: ensureInstructionsBlock(paths.instructions),
  };
}

export interface CopilotUninstallResult {
  readonly paths: CopilotPaths;
  readonly hooks: boolean;
  readonly mcp: McpRemoveStatus;
  readonly instructions: boolean;
}

export function uninstallCopilot(): CopilotUninstallResult {
  const paths = copilotPaths();
  return {
    paths,
    hooks: uninstallJsonHooks('copilot'),
    mcp: removeMcpServer(paths.mcpConfig),
    instructions: removeInstructionsBlock(paths.instructions),
  };
}
