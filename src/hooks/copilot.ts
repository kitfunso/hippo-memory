// GitHub Copilot: hippo's hooks file, one MCP server key and an instructions block under the Copilot home folder,
// plus the MCP server and an instructions file in each VS Code User folder.
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import type { JsonObject } from '../working-memory.js';
import { type JsonValue, readJsonFile } from '../json.js';
import { HOOK_MARKERS, hippoBlock } from '../cli/hook-blocks.js';
import { copilotHomeDir, isJsonObject, vscodeUserDirs } from './shared.js';
import { writeFileAtomic } from '../util/atomic-write.js';
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

The installed hooks load pinned memories when a session starts and capture
the session as you work, so there is nothing to run before you finish.
`.trim();

/** Every Copilot text a release has written, so install upgrades an old block and uninstall still removes it; add the old text when the text changes. */
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

export const VSCODE_INSTRUCTIONS = withApplyToAll(COPILOT_INSTRUCTIONS);

function isHipposVscodeInstructions(text: string): boolean {
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

function profileDirs(userDir: string): string[] {
  const dir = path.join(userDir, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)).sort();
}

export function copilotPaths(): CopilotPaths {
  const home = copilotHomeDir();
  return {
    hooks: resolveJsonHookPaths('copilot').settings,
    mcpConfig: path.join(home, 'mcp-config.json'),
    instructions: path.join(home, 'copilot-instructions.md'),
    vscode: vscodeUserDirs().map((userDir) => ({
      userDir,
      mcpConfig: path.join(userDir, 'mcp.json'),
      instructions: path.join(userDir, 'prompts', 'hippo.instructions.md'),
      profiles: profileDirs(userDir),
    })),
  };
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
export const COPILOT_CLI_MCP: McpHost = { key: 'mcpServers', server: () => ({ type: 'local', command: hippoCommand(), args: ['mcp'], env: {}, tools: ['*'] }) };

/** VS Code's mcp.json keeps stdio servers under "servers"; it has no "mcpServers" key. */
export const VSCODE_MCP: McpHost = { key: 'servers', server: () => ({ type: 'stdio', command: hippoCommand(), args: ['mcp'] }) };

/** Only a server hippo wrote counts as hippo's: another command, other args, or any key or value setup does not write (an env you added) makes it the user's. */
function isHipposServer(entry: JsonValue | undefined, host: McpHost): boolean {
  if (!isJsonObject(entry) || !('command' in entry) || !('args' in entry)) return false;
  const ours = host.server();
  return Object.entries(entry).every(([key, value]) => (key === 'command' ? value === 'hippo' || value === 'hippo.cmd' : isDeepStrictEqual(value, ours[key])));
}

/** What to paste under the host's key when hippo cannot edit the file itself. */
export function copilotMcpSnippet(host: McpHost = COPILOT_CLI_MCP): string {
  return `"${MCP_KEY}": ${JSON.stringify(host.server())}`;
}

interface McpConfig {
  readonly config: JsonObject;
  readonly servers: JsonObject;
}

/** Null for a file with comments, one that is not JSON, or one whose shape a merge would overwrite; a missing file reads as empty. */
function readMcpConfig(file: string, host: McpHost): McpConfig | null {
  let config: JsonValue = {};
  if (fs.existsSync(file)) {
    try {
      config = readJsonFile(file);
    } catch (err) {
      // Only a parse failure means the text is not JSON hippo can merge; EACCES or EISDIR is thrown with its own message.
      if (!(err instanceof SyntaxError)) throw err;
      // An empty file is a new one with no servers yet, not one with comments.
      if (fs.readFileSync(file, 'utf8').trim() !== '') return null;
    }
  }
  if (!isJsonObject(config)) return null;
  if (config[host.key] === undefined) config[host.key] = {};
  const servers = config[host.key];
  return isJsonObject(servers) ? { config, servers } : null;
}

export type McpMergeStatus = 'added' | 'present' | 'user-owned' | 'unreadable';

/** Adds hippo's server and keeps every other key; a file hippo cannot parse, or a "hippo" key it did not write, stays as it is. */
export function mergeMcpServer(file: string, host: McpHost = COPILOT_CLI_MCP): McpMergeStatus {
  const read = readMcpConfig(file, host);
  if (read === null) return 'unreadable';
  const existing = read.servers[MCP_KEY];
  if (existing !== undefined) return isHipposServer(existing, host) ? 'present' : 'user-owned';
  read.servers[MCP_KEY] = host.server();
  writeSettingsFile(file, read.config);
  return 'added';
}

export type McpRemoveStatus = 'removed' | 'absent' | 'user-owned' | 'unreadable';

/** Removes the "hippo" key only when hippo wrote it. */
export function removeMcpServer(file: string, host: McpHost = COPILOT_CLI_MCP): McpRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const read = readMcpConfig(file, host);
  if (read === null) return 'unreadable';
  const existing = read.servers[MCP_KEY];
  if (existing === undefined) return 'absent';
  if (!isHipposServer(existing, host)) return 'user-owned';
  delete read.servers[MCP_KEY];
  if (Object.keys(read.servers).length === 0) delete read.config[host.key];
  writeSettingsFile(file, read.config);
  return 'removed';
}

/** A filesystem error on an MCP config file (EACCES, EISDIR, EBUSY), kept as its own message so setup can report it and go on. */
export interface McpFailure {
  readonly failed: string;
}

export function isMcpFailure(status: string | McpFailure): status is McpFailure {
  return typeof status !== 'string';
}

function hasErrnoCode(err: Error): err is NodeJS.ErrnoException {
  return 'code' in err && typeof err.code === 'string';
}

/** One MCP config step; a filesystem error comes back as a failure, so the hooks file and the instructions still install. */
function mcpStep<S extends string>(step: () => S): S | McpFailure {
  try {
    return step();
  } catch (err) {
    if (err instanceof Error && hasErrnoCode(err)) return { failed: err.message };
    throw err;
  }
}

function isCopilotBlock(inner: string): boolean {
  return SHIPPED_COPILOT_INSTRUCTIONS.includes(inner);
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
function ensureInstructionsBlock(file: string): InstructionsInstallStatus {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const found = hippoBlock(old);
  if (found === null && old.includes(HOOK_MARKERS.start)) return 'unclosed';
  if (found !== null && !isCopilotBlock(found.inner)) return 'kept';
  const next = withCopilotBlock(old, found);
  if (next === old) return 'present';
  writeFileAtomic(file, next);
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
  else writeFileAtomic(file, left);
  return 'removed';
}

/** `kept`: the file is there but is not the text hippo writes, so the user edited it or it is someone else's. */
export type VscodeInstructionsInstallStatus = 'written' | 'present' | 'kept';

/** The file is hippo's alone, so it is written whole; an earlier hippo text is upgraded, and any other text already there stays. */
export function ensureVscodeInstructions(file: string): VscodeInstructionsInstallStatus {
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    if (old === VSCODE_INSTRUCTIONS) return 'present';
    if (!isHipposVscodeInstructions(old)) return 'kept';
  }
  writeFileAtomic(file, VSCODE_INSTRUCTIONS);
  return 'written';
}

export type VscodeInstructionsRemoveStatus = 'removed' | 'absent' | 'kept';

/** Deletes the file only when it still holds exactly what a hippo release wrote. */
export function removeVscodeInstructions(file: string): VscodeInstructionsRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  if (!isHipposVscodeInstructions(fs.readFileSync(file, 'utf8'))) return 'kept';
  fs.rmSync(file);
  return 'removed';
}

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

/** The CLI's folder holds more than the hooks folder setup makes for VS Code, so a rerun on a VS Code-only machine still finds no CLI. */
export function isCopilotCliPresent(home: string = copilotHomeDir()): boolean {
  if (fs.statSync(home, { throwIfNoEntry: false })?.isDirectory() !== true) return false;
  const entries = fs.readdirSync(home);
  return entries.length !== 1 || entries[0] !== 'hooks';
}

export function installCopilot(): CopilotInstallResult {
  const paths = copilotPaths();
  // Read before the hooks install, which makes the folder on a machine with only VS Code.
  const cli = isCopilotCliPresent();
  return {
    paths,
    hooks: installJsonHooks('copilot').installedSessionStart,
    mcp: cli ? mcpStep(() => mergeMcpServer(paths.mcpConfig)) : null,
    instructions: cli ? ensureInstructionsBlock(paths.instructions) : null,
    vscode: paths.vscode.map((dir) => ({
      paths: dir,
      mcp: mcpStep(() => mergeMcpServer(dir.mcpConfig, VSCODE_MCP)),
      instructions: ensureVscodeInstructions(dir.instructions),
    })),
  };
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

export function uninstallCopilot(): CopilotUninstallResult {
  const paths = copilotPaths();
  return {
    paths,
    hooks: uninstallJsonHooks('copilot'),
    mcp: mcpStep(() => removeMcpServer(paths.mcpConfig)),
    instructions: removeInstructionsBlock(paths.instructions),
    vscode: paths.vscode.map((dir) => ({
      paths: dir,
      mcp: mcpStep(() => removeMcpServer(dir.mcpConfig, VSCODE_MCP)),
      instructions: removeVscodeInstructions(dir.instructions),
    })),
  };
}
