// GitHub Copilot: hippo's hooks file, one MCP server key and an instructions block, all under the Copilot home folder.
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '../working-memory.js';
import { type JsonValue, readJsonFile } from '../json.js';
import { HOOK_MARKERS, hippoBlock } from '../cli/hook-blocks.js';
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
    } catch (err) {
      // Only a parse failure means the text is not JSON hippo can merge; EACCES or EISDIR is thrown with its own message.
      if (err instanceof SyntaxError) return null;
      throw err;
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

/** A filesystem error on mcp-config.json (EACCES, EISDIR, EBUSY), kept as its own message so setup can report it and go on. */
export interface McpFailure {
  readonly failed: string;
}

export function isMcpFailure(status: string | McpFailure): status is McpFailure {
  return typeof status !== 'string';
}

function hasErrnoCode(err: Error): err is NodeJS.ErrnoException {
  return 'code' in err && typeof err.code === 'string';
}

/** One mcp-config.json step; a filesystem error comes back as a failure, so the hooks file and the block still install. */
function mcpStep<S extends string>(step: () => S): S | McpFailure {
  try {
    return step();
  } catch (err) {
    if (err instanceof Error && hasErrnoCode(err)) return { failed: err.message };
    throw err;
  }
}

// A later release adds the hash of each earlier Copilot text here, as SHIPPED_HOOK_HASHES does for the other agents.
function isCopilotBlock(inner: string): boolean {
  return inner === COPILOT_INSTRUCTIONS;
}

type FoundBlock = NonNullable<ReturnType<typeof hippoBlock>>;

/** Replaces only the text between the markers, in the file's own line ending, or appends a block after the user's text. */
function withCopilotBlock(text: string, found: FoundBlock | null): string {
  if (found !== null) {
    const { start, end, eol } = found;
    return `${text.slice(0, start)}${eol}${COPILOT_INSTRUCTIONS.replace(/\n/g, eol)}${eol}${text.slice(end)}`;
  }
  const block = `${HOOK_MARKERS.start}\n${COPILOT_INSTRUCTIONS}\n${HOOK_MARKERS.end}\n`;
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

/** `kept`: a hippo block that is not the Copilot text (edited, or another agent's in a shared file); `unclosed`: a start marker with no end. */
export type InstructionsInstallStatus = 'written' | 'present' | 'kept' | 'unclosed';

/** Creates the file when missing; any block but hippo's own Copilot one, and a start marker with no end, leave the file as it is. */
export function ensureInstructionsBlock(file: string): InstructionsInstallStatus {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const found = hippoBlock(old);
  if (found === null && old.includes(HOOK_MARKERS.start)) return 'unclosed';
  if (found !== null && !isCopilotBlock(found.inner)) return 'kept';
  const next = withCopilotBlock(old, found);
  if (next === old) return 'present';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  return 'written';
}

/** `text` without the block and its markers, plus the line break after the end marker, else the one before the start marker. */
function withoutCopilotBlock(text: string, found: FoundBlock): string {
  const from = found.start - HOOK_MARKERS.start.length;
  const to = found.end + HOOK_MARKERS.end.length;
  const after = text.startsWith('\r\n', to) ? 2 : text.startsWith('\n', to) ? 1 : 0;
  const before = after > 0 ? 0 : text.endsWith('\r\n', from) ? 2 : text.endsWith('\n', from) ? 1 : 0;
  return text.slice(0, from - before) + text.slice(to + after);
}

export type InstructionsRemoveStatus = 'removed' | 'absent' | 'kept' | 'unclosed';

/** Splices out only hippo's own Copilot block and keeps every other byte; a file left with nothing but whitespace goes. */
export function removeInstructionsBlock(file: string): InstructionsRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const old = fs.readFileSync(file, 'utf8');
  const found = hippoBlock(old);
  if (found === null) return old.includes(HOOK_MARKERS.start) ? 'unclosed' : 'absent';
  if (!isCopilotBlock(found.inner)) return 'kept';
  const left = withoutCopilotBlock(old, found);
  if (left.trim() === '') fs.rmSync(file);
  else fs.writeFileSync(file, left, 'utf8');
  return 'removed';
}

export interface CopilotInstallResult {
  readonly paths: CopilotPaths;
  /** True when the hooks file was written; false when it already held hippo's current table. */
  readonly hooks: boolean;
  readonly mcp: McpMergeStatus | McpFailure;
  readonly instructions: InstructionsInstallStatus;
}

export function installCopilot(): CopilotInstallResult {
  const paths = copilotPaths();
  return {
    paths,
    hooks: installJsonHooks('copilot').installedSessionStart,
    mcp: mcpStep(() => mergeMcpServer(paths.mcpConfig)),
    instructions: ensureInstructionsBlock(paths.instructions),
  };
}

export interface CopilotUninstallResult {
  readonly paths: CopilotPaths;
  readonly hooks: boolean;
  readonly mcp: McpRemoveStatus | McpFailure;
  readonly instructions: InstructionsRemoveStatus;
}

export function uninstallCopilot(): CopilotUninstallResult {
  const paths = copilotPaths();
  return {
    paths,
    hooks: uninstallJsonHooks('copilot'),
    mcp: mcpStep(() => removeMcpServer(paths.mcpConfig)),
    instructions: removeInstructionsBlock(paths.instructions),
  };
}
