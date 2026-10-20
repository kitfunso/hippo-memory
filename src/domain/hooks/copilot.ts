// GitHub Copilot: what hippo writes in its hooks file, its MCP server key and its instructions, under the Copilot home
// and each VS Code User folder; surface/hooks-install/copilot.ts reads and writes the files.
import { isDeepStrictEqual } from 'node:util';
import { type JsonValue, isJsonObjectLiteral, type JsonObject } from '../../base/util/json.js';
import { HOOK_MARKERS, hippoBlock } from './hook-blocks.js';

const MCP_KEY = 'hippo';

/** Copilot drops what a per-prompt hook prints, so per-task recall goes through the MCP tool the block names. */
const COPILOT_INSTRUCTIONS = `
## Project Memory (Hippo)

At the start of each task, call the \`hippo_recall\` tool with a short query that
names the task. Read the memories it returns before you write any code.

When you learn something that should outlive this session (a decision and its
reason, a user preference, why something failed), call the \`hippo_remember\`
tool right then, while you work, never as a closing step. Set \`error\` to true
for a failure. Leave out secrets and personal details.

The installed hooks load pinned memories when a session starts and capture
the session as you work, so there is nothing to run before you finish.
`.trim();

/**
 * Every Copilot text a release has written, so install upgrades an old block and uninstall still removes it; add the
 * old text when the text changes.
 */
const SHIPPED_COPILOT_INSTRUCTIONS: readonly string[] = [
  COPILOT_INSTRUCTIONS,
  `
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
`.trim(),
];

/** VS Code attaches a User `*.instructions.md` file to every chat request its `applyTo` glob matches. */
const withApplyToAll = (text: string): string => `---\napplyTo: "**"\n---\n${text}\n`;

/** The whole file hippo writes in each VS Code User folder. */
export const VSCODE_INSTRUCTIONS = withApplyToAll(COPILOT_INSTRUCTIONS);

export function isHipposVscodeInstructions(text: string): boolean {
  return SHIPPED_COPILOT_INSTRUCTIONS.some((shipped) => text === withApplyToAll(shipped));
}

/** The files hippo writes in one VS Code User folder. */
export interface VscodePaths {
  readonly userDir: string;
  readonly mcpConfig: string;
  readonly instructions: string;
  /** Profile folders, which keep their own mcp.json and prompts; hippo installs into the default profile only. */
  readonly profiles: readonly string[];
}

/** The three files hippo writes for Copilot, plus the two it writes in each VS Code User folder. */
export interface CopilotPaths {
  readonly hooks: string;
  readonly mcpConfig: string;
  readonly instructions: string;
  readonly vscode: readonly VscodePaths[];
}

/** The app that reads an MCP config: where it keeps its servers, and hippo's entry there. */
export interface McpHost {
  readonly key: 'mcpServers' | 'servers';
  server(): JsonObject;
}

/** Windows gets npm's .cmd shim, as the Codex hooks do, since a PowerShell execution policy can block hippo.ps1. */
function hippoCommand(): string {
  return process.platform === 'win32' ? 'hippo.cmd' : 'hippo';
}

/** The Copilot CLI's mcp-config.json keeps servers under "mcpServers", each with an env and a tool list. */
export const COPILOT_CLI_MCP: McpHost = {
  key: 'mcpServers',
  server: () => ({ type: 'local', command: hippoCommand(), args: ['mcp'], env: {}, tools: ['*'] }),
};

/** VS Code's mcp.json keeps stdio servers under "servers"; it has no "mcpServers" key. */
export const VSCODE_MCP: McpHost = {
  key: 'servers',
  server: () => ({ type: 'stdio', command: hippoCommand(), args: ['mcp'] }),
};

/** Only a server hippo wrote counts as hippo's: another command, other args, or any key or value setup does not write
 * (an env you added) makes it the user's. */
function isHipposServer(entry: JsonValue | undefined, host: McpHost): boolean {
  if (!isJsonObjectLiteral(entry) || !('command' in entry) || !('args' in entry)) return false;
  const ours = host.server();
  return Object.entries(entry).every(([key, value]) =>
    key === 'command' ? value === 'hippo' || value === 'hippo.cmd' : isDeepStrictEqual(value, ours[key]),
  );
}

/** What to paste under the host's key when hippo cannot edit the file itself. */
export function copilotMcpSnippet(host: McpHost = COPILOT_CLI_MCP): string {
  return `"${MCP_KEY}": ${JSON.stringify(host.server())}`;
}

/** An MCP config file's parsed object and the server table under the host's key, edited in place. */
export interface McpConfig {
  readonly config: JsonObject;
  readonly servers: JsonObject;
}

/** Null for text that is not a JSON object, or one whose shape a merge would overwrite; the server table is made when
 * absent. */
export function mcpConfigOf(config: JsonValue, host: McpHost): McpConfig | null {
  if (!isJsonObjectLiteral(config)) return null;
  if (config[host.key] === undefined) config[host.key] = {};
  const servers = config[host.key];
  return isJsonObjectLiteral(servers) ? { config, servers } : null;
}

export type McpMergeStatus = 'added' | 'present' | 'user-owned' | 'unreadable';

/** Adds hippo's server and keeps every other key; a "hippo" key hippo did not write stays as it is. The caller writes
 * the config on `added`. */
export function addHippoServer(read: McpConfig, host: McpHost): Exclude<McpMergeStatus, 'unreadable'> {
  const existing = read.servers[MCP_KEY];
  if (existing !== undefined) return isHipposServer(existing, host) ? 'present' : 'user-owned';
  read.servers[MCP_KEY] = host.server();
  return 'added';
}

export type McpRemoveStatus = 'removed' | 'absent' | 'user-owned' | 'unreadable';

/** Removes the "hippo" key only when hippo wrote it, and the host's table once it is empty. The caller writes the
 * config on `removed`. */
export function removeHippoServer(read: McpConfig, host: McpHost): Exclude<McpRemoveStatus, 'unreadable'> {
  const existing = read.servers[MCP_KEY];
  if (existing === undefined) return 'absent';
  if (!isHipposServer(existing, host)) return 'user-owned';
  delete read.servers[MCP_KEY];
  if (Object.keys(read.servers).length === 0) delete read.config[host.key];
  return 'removed';
}

/** A filesystem error on an MCP config file (EACCES, EISDIR, EBUSY), kept as its own message so setup can report it
 * and go on. */
export interface McpFailure {
  readonly failed: string;
}

export function isMcpFailure(status: string | McpFailure): status is McpFailure {
  return typeof status !== 'string';
}

function isCopilotBlock(inner: string): boolean {
  return SHIPPED_COPILOT_INSTRUCTIONS.includes(inner);
}

type FoundBlock = NonNullable<ReturnType<typeof hippoBlock>>;

/** Replaces only the text between the markers, in the file's own line ending, or appends a block after the user's
 * text. */
function withCopilotBlock(text: string, found: FoundBlock | null): string {
  if (found !== null) {
    const { start, end, eol } = found;
    return `${text.slice(0, start)}${eol}${COPILOT_INSTRUCTIONS.replace(/\n/g, eol)}${eol}${text.slice(end)}`;
  }
  const block = `${HOOK_MARKERS.start}\n${COPILOT_INSTRUCTIONS}\n${HOOK_MARKERS.end}\n`;
  if (text === '') return block;
  return `${text}${text.endsWith('\n') ? '\n' : '\n\n'}${block}`;
}

/** `kept`: a hippo block that is not the Copilot text (edited, or another agent's in a shared file); `unclosed`: a
 * start marker with no end. */
export type InstructionsInstallStatus = 'written' | 'present' | 'kept' | 'unclosed';

export interface InstructionsPlan {
  readonly status: InstructionsInstallStatus;
  readonly next: string;
}

/** The instructions file's next text, `old` being '' for a missing file; any block but hippo's own Copilot one, and a
 * start marker with no end, leave it as it is. The caller writes `next` on `written`. */
export function planInstructionsBlock(old: string): InstructionsPlan {
  const found = hippoBlock(old);
  if (found === null && old.includes(HOOK_MARKERS.start)) return { status: 'unclosed', next: old };
  if (found !== null && !isCopilotBlock(found.inner)) return { status: 'kept', next: old };
  const next = withCopilotBlock(old, found);
  return { status: next === old ? 'present' : 'written', next };
}

/** `text` without the block and its markers, plus the line break after the end marker, else the one before the start
 * marker. */
function withoutCopilotBlock(text: string, found: FoundBlock): string {
  const from = found.start - HOOK_MARKERS.start.length;
  const to = found.end + HOOK_MARKERS.end.length;
  const after = text.startsWith('\r\n', to) ? 2 : text.startsWith('\n', to) ? 1 : 0;
  const before = after > 0 ? 0 : text.endsWith('\r\n', from) ? 2 : text.endsWith('\n', from) ? 1 : 0;
  return text.slice(0, from - before) + text.slice(to + after);
}

export type InstructionsRemoveStatus = 'removed' | 'absent' | 'kept' | 'unclosed';

/** On `removed`, `left` null means the file held nothing but hippo's block and goes. */
export interface InstructionsRemovalPlan {
  readonly status: InstructionsRemoveStatus;
  readonly left: string | null;
}

/** Splices out only hippo's own Copilot block and keeps every other byte. */
export function planInstructionsRemoval(old: string): InstructionsRemovalPlan {
  const found = hippoBlock(old);
  if (found === null) return { status: old.includes(HOOK_MARKERS.start) ? 'unclosed' : 'absent', left: old };
  if (!isCopilotBlock(found.inner)) return { status: 'kept', left: old };
  const left = withoutCopilotBlock(old, found);
  return { status: 'removed', left: left.trim() === '' ? null : left };
}

/** `kept`: the file is there but is not the text hippo writes, so the user edited it or it is someone else's. */
export type VscodeInstructionsInstallStatus = 'written' | 'present' | 'kept';

/** The file is hippo's alone, so it is written whole; an earlier hippo text is upgraded, and any other text already
 * there stays. `old` is null for a missing file; the caller writes VSCODE_INSTRUCTIONS on `written`. */
export function planVscodeInstructions(old: string | null): VscodeInstructionsInstallStatus {
  if (old === null) return 'written';
  if (old === VSCODE_INSTRUCTIONS) return 'present';
  return isHipposVscodeInstructions(old) ? 'written' : 'kept';
}

export type VscodeInstructionsRemoveStatus = 'removed' | 'absent' | 'kept';

export interface VscodeInstallResult {
  readonly paths: VscodePaths;
  readonly mcp: McpMergeStatus | McpFailure;
  readonly instructions: VscodeInstructionsInstallStatus;
}

export interface CopilotInstallResult {
  readonly paths: CopilotPaths;
  /** True when the hooks file was written; false when it already held hippo's current table. */
  readonly hooks: boolean;
  /** Null, like `instructions`, when the Copilot CLI is not installed, since only it reads these two files. */
  readonly mcp: McpMergeStatus | McpFailure | null;
  readonly instructions: InstructionsInstallStatus | null;
  readonly vscode: readonly VscodeInstallResult[];
}

export interface VscodeUninstallResult {
  readonly paths: VscodePaths;
  readonly mcp: McpRemoveStatus | McpFailure;
  readonly instructions: VscodeInstructionsRemoveStatus;
}

export interface CopilotUninstallResult {
  readonly paths: CopilotPaths;
  readonly hooks: boolean;
  readonly mcp: McpRemoveStatus | McpFailure;
  readonly instructions: InstructionsRemoveStatus;
  readonly vscode: readonly VscodeUninstallResult[];
}
