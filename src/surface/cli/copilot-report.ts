// The lines `hippo hook` and `hippo setup` print when they install or remove Copilot's files.

import * as path from 'node:path';
import { copilotHookEvents } from '../hooks-install/json-hooks.js';
import type {
  CopilotInstallResult,
  CopilotUninstallResult,
  InstructionsInstallStatus,
  InstructionsRemoveStatus,
  McpFailure,
  McpHost,
  McpMergeStatus,
  McpRemoveStatus,
  VscodeInstallResult,
  VscodeInstructionsInstallStatus,
  VscodeInstructionsRemoveStatus,
} from '../hooks-install/rules/copilot.js';
import {
  COPILOT_CLI_MCP,
  VSCODE_MCP,
  copilotMcpSnippet,
  isMcpFailure,
} from '../hooks-install/copilot.js';
import { HOOK_MARKERS } from '../hooks-install/instructions.js';

const addByHand = (host: McpHost): string =>
  `add this under "${host.key}" by hand: ${copilotMcpSnippet(host)}`;

const MCP_MERGE_LINES = {
  added: (file: string) => `Added the "hippo" MCP server -> ${file}`,
  present: (file: string) => `The "hippo" MCP server is already in ${file}`,
  'user-owned': (file: string) =>
    `Left the "hippo" MCP server in ${file} as it is: hippo did not write it`,
  unreadable: (file: string, host: McpHost) =>
    `WARNING: ${file} has comments or is not a JSON object hippo can merge into, so it was left unchanged; ` +
    addByHand(host),
} as const satisfies Record<McpMergeStatus, (file: string, host: McpHost) => string>;

const mcpFailureLine = (file: string, failure: McpFailure, fix: string): string =>
  `WARNING: hippo could not use ${file} (${failure.failed}), so it was left unchanged; ${fix}`;

const unclosedLine = (file: string): string =>
  `WARNING: ${file} has ${HOOK_MARKERS.start} with no ${HOOK_MARKERS.end}, so hippo left it unchanged; ` +
  'fix the markers by hand';

const INSTRUCTIONS_INSTALL_LINES = {
  written: (file: string) => `Wrote the hippo block -> ${file}`,
  present: (file: string) => `The hippo block is already in ${file}`,
  kept: (file: string) =>
    `Kept the hippo block in ${file} as it is: it is not the Copilot text hippo wrote, ` +
    `so it was edited or is another agent's`,
  unclosed: unclosedLine,
} as const satisfies Record<InstructionsInstallStatus, (file: string) => string>;

const INSTRUCTIONS_REMOVE_LINES = {
  removed: (file: string) => `Removed the hippo block from ${file}`,
  absent: () => '',
  kept: (file: string) =>
    `Left the hippo block in ${file}: it is not the Copilot text hippo wrote. ` +
    'Delete it by hand if no agent needs it.',
  unclosed: unclosedLine,
} as const satisfies Record<InstructionsRemoveStatus, (file: string) => string>;

const VSCODE_INSTRUCTIONS_INSTALL_LINES = {
  written: (file: string) => `Wrote the hippo instructions file -> ${file}`,
  present: (file: string) => `The hippo instructions file is already at ${file}`,
  kept: (file: string) =>
    `Kept ${file} as it is: it is not the text hippo writes, so it was edited or is someone else's`,
} as const satisfies Record<VscodeInstructionsInstallStatus, (file: string) => string>;

const VSCODE_INSTRUCTIONS_REMOVE_LINES = {
  removed: (file: string) => `Removed the hippo instructions file ${file}`,
  absent: () => '',
  kept: (file: string) =>
    `Left ${file}: it is not the text hippo wrote. Delete it by hand if no agent needs it.`,
} as const satisfies Record<VscodeInstructionsRemoveStatus, (file: string) => string>;

const VSCODE_HOOKS_LINE =
  'VS Code: hooks need VS Code 1.109.3 or later with chat.useHooks on (the default); ' +
  'older versions get the MCP server and the instructions file only.';

function mcpInstallLine(file: string, mcp: McpMergeStatus | McpFailure, host: McpHost): string {
  return isMcpFailure(mcp)
    ? mcpFailureLine(file, mcp, addByHand(host))
    : MCP_MERGE_LINES[mcp](file, host);
}

function printVscodeInstall(result: VscodeInstallResult, indent: string): void {
  const { paths } = result;
  console.log(`${indent}${mcpInstallLine(paths.mcpConfig, result.mcp, VSCODE_MCP)}`);
  console.log(
    `${indent}${VSCODE_INSTRUCTIONS_INSTALL_LINES[result.instructions](paths.instructions)}`,
  );
  if (paths.profiles.length > 0) {
    const names = paths.profiles.map((dir) => path.basename(dir)).join(', ');
    console.log(
      `${indent}Found VS Code profiles (${names}) under ${path.join(paths.userDir, 'profiles')}: ` +
        'hippo set up the default profile only; copy the "hippo" server and prompts/hippo.instructions.md ' +
        'into a profile to use hippo there.',
    );
  }
}

export function printCopilotInstall(result: CopilotInstallResult, indent: string): void {
  const { paths } = result;
  const hooks = result.hooks
    ? `Installed hippo's Copilot hooks (${copilotHookEvents().join(', ')}) ->`
    : "hippo's Copilot hooks are already in";
  console.log(`${indent}${hooks} ${paths.hooks}`);
  if (result.mcp === null || result.instructions === null) {
    console.log(
      `${indent}No Copilot CLI files in ${path.dirname(paths.mcpConfig)}, ` +
        'so hippo skipped mcp-config.json and copilot-instructions.md, which only the Copilot CLI reads',
    );
  } else {
    console.log(`${indent}${mcpInstallLine(paths.mcpConfig, result.mcp, COPILOT_CLI_MCP)}`);
    console.log(`${indent}${INSTRUCTIONS_INSTALL_LINES[result.instructions](paths.instructions)}`);
  }
  for (const vscode of result.vscode) printVscodeInstall(vscode, indent);
  if (result.vscode.length > 0) console.log(`${indent}${VSCODE_HOOKS_LINE}`);
  console.log(`${indent}VS Code Copilot runs new hooks in a new chat session.`);
}

/** The lines for one MCP config file; empty when hippo's server was not there. */
function mcpRemoveLines(file: string, mcp: McpRemoveStatus | McpFailure): string[] {
  if (isMcpFailure(mcp)) {
    return [mcpFailureLine(file, mcp, 'remove the "hippo" server by hand if hippo added it')];
  }
  if (mcp === 'removed') return [`Removed the "hippo" MCP server from ${file}`];
  if (mcp === 'user-owned') {
    return [`Left the "hippo" MCP server in ${file}: hippo did not write it`];
  }
  if (mcp === 'unreadable') {
    return [
      `WARNING: ${file} has comments or is not a JSON object hippo can edit, so it was left unchanged; ` +
        'remove the "hippo" server by hand if hippo added it',
    ];
  }
  return [];
}

export function printCopilotUninstall(result: CopilotUninstallResult): void {
  const { paths, mcp } = result;
  const lines: string[] = [];
  if (result.hooks) lines.push(`Removed hippo's Copilot hooks file ${paths.hooks}`);
  lines.push(...mcpRemoveLines(paths.mcpConfig, mcp));
  lines.push(INSTRUCTIONS_REMOVE_LINES[result.instructions](paths.instructions));
  for (const vscode of result.vscode) {
    lines.push(...mcpRemoveLines(vscode.paths.mcpConfig, vscode.mcp));
    lines.push(VSCODE_INSTRUCTIONS_REMOVE_LINES[vscode.instructions](vscode.paths.instructions));
  }
  const printed = lines.filter((line) => line !== '');
  for (const line of printed) console.log(line);
  if (printed.length === 0) {
    console.log('No hippo Copilot hooks, MCP server or instructions found.');
  }
}
