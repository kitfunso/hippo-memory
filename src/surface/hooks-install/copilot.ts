// Reads and writes hippo's GitHub Copilot files: the hooks file, the MCP configs and the instructions under the Copilot
// home and each VS Code User folder. What goes in them is domain/hooks/copilot.ts.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { type JsonValue } from '../../base/util/json.js';
import { readJsonFile } from '../../host/json-file.js';
import {
  addHippoServer,
  COPILOT_CLI_MCP,
  isHipposVscodeInstructions,
  mcpConfigOf,
  planInstructionsBlock,
  planInstructionsRemoval,
  planVscodeInstructions,
  removeHippoServer,
  VSCODE_INSTRUCTIONS,
  VSCODE_MCP,
  type CopilotInstallResult,
  type CopilotPaths,
  type CopilotUninstallResult,
  type InstructionsInstallStatus,
  type InstructionsRemoveStatus,
  type McpConfig,
  type McpFailure,
  type McpHost,
  type McpMergeStatus,
  type McpRemoveStatus,
  type VscodeInstructionsInstallStatus,
  type VscodeInstructionsRemoveStatus,
} from '../../domain/hooks/copilot.js';
import { copilotHomeDir } from '../../domain/hooks/shared.js';
import { processHomes } from '../../host/agent-homes.js';
import { vscodeUserDirs } from './detect.js';
import { installJsonHooks, resolveJsonHookPaths, uninstallJsonHooks, writeSettingsFile } from './json-hooks.js';

// The MCP hosts the installer merges into, and the snippet and failure test its caller prints from.
export { COPILOT_CLI_MCP, VSCODE_MCP, copilotMcpSnippet, isMcpFailure } from '../../domain/hooks/copilot.js';

function profileDirs(userDir: string): string[] {
  const dir = path.join(userDir, 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .sort();
}

export function copilotPaths(): CopilotPaths {
  const home = copilotHomeDir(processHomes());
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

/** Null for a file with comments, one that is not JSON, or one whose shape a merge would overwrite; a missing file
 * reads as empty. */
function readMcpConfig(file: string, host: McpHost): McpConfig | null {
  let config: JsonValue = {};
  if (fs.existsSync(file)) {
    try {
      config = readJsonFile(file);
    } catch (err) {
      // Only a parse failure means the text is not JSON hippo can merge; EACCES or EISDIR is thrown with its own
      // message.
      if (!(err instanceof SyntaxError)) throw err;
      // An empty file is a new one with no servers yet, not one with comments.
      if (fs.readFileSync(file, 'utf8').trim() !== '') return null;
    }
  }
  return mcpConfigOf(config, host);
}

function mergeMcpServer(file: string, host: McpHost = COPILOT_CLI_MCP): McpMergeStatus {
  const read = readMcpConfig(file, host);
  if (read === null) return 'unreadable';
  const status = addHippoServer(read, host);
  if (status === 'added') writeSettingsFile(file, read.config);
  return status;
}

function removeMcpServer(file: string, host: McpHost = COPILOT_CLI_MCP): McpRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const read = readMcpConfig(file, host);
  if (read === null) return 'unreadable';
  const status = removeHippoServer(read, host);
  if (status === 'removed') writeSettingsFile(file, read.config);
  return status;
}

function hasErrnoCode(err: Error): err is NodeJS.ErrnoException {
  return 'code' in err && typeof err.code === 'string';
}

/** One MCP config step; a filesystem error comes back as a failure, so the hooks file and the instructions still
 * install. */
function mcpStep<S extends string>(step: () => S): S | McpFailure {
  try {
    return step();
  } catch (err) {
    if (err instanceof Error && hasErrnoCode(err)) return { failed: err.message };
    throw err;
  }
}

/** Creates the file when missing. */
function ensureInstructionsBlock(file: string): InstructionsInstallStatus {
  const plan = planInstructionsBlock(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  if (plan.status === 'written') writeFileAtomic(file, plan.next);
  return plan.status;
}

function removeInstructionsBlock(file: string): InstructionsRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  const plan = planInstructionsRemoval(fs.readFileSync(file, 'utf8'));
  if (plan.status === 'removed') {
    if (plan.left === null) fs.rmSync(file);
    else writeFileAtomic(file, plan.left);
  }
  return plan.status;
}

function ensureVscodeInstructions(file: string): VscodeInstructionsInstallStatus {
  const status = planVscodeInstructions(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  if (status === 'written') writeFileAtomic(file, VSCODE_INSTRUCTIONS);
  return status;
}

/** Deletes the file only when it still holds exactly what a hippo release wrote. */
function removeVscodeInstructions(file: string): VscodeInstructionsRemoveStatus {
  if (!fs.existsSync(file)) return 'absent';
  if (!isHipposVscodeInstructions(fs.readFileSync(file, 'utf8'))) return 'kept';
  fs.rmSync(file);
  return 'removed';
}

/** The CLI's folder holds more than the hooks folder setup makes for VS Code, so a rerun on a VS Code-only machine
 * still finds no CLI. */
export function isCopilotCliPresent(home: string = copilotHomeDir(processHomes())): boolean {
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
