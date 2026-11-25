// The lines `hippo hook` and `hippo setup` print when they install or remove Copilot's files.

import * as path from 'node:path';
import {
  copilotHookEvents,
  type CopilotInstallResult,
  type CopilotUninstallResult,
  type InstructionsInstallStatus,
  type InstructionsRemoveStatus,
  type VscodeInstallResult,
  type VscodeInstructionsInstallStatus,
  type VscodeInstructionsRemoveStatus,
} from '../hooks-install/rules/copilot.js';
import type {
  McpConfigHost,
  McpFailure,
  McpMergeStatus,
  McpRemoveStatus,
} from '../hooks-install/rules/mcp-config.js';
import { COPILOT_CLI_MCP, VSCODE_MCP } from '../hooks-install/copilot.js';
import { HOOK_MARKERS } from '../hooks-install/instructions.js';
import { mcpInstallLines, mcpRemoveLines, type McpReportTarget } from './mcp-config-report.js';

const copilotTarget = (host: McpConfigHost): McpReportTarget => ({
  name: 'copilot',
  format: { kind: 'json', host },
});

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

function printMcpInstall(
  file: string,
  mcp: McpMergeStatus | McpFailure,
  host: McpConfigHost,
  indent: string,
): void {
  for (const line of mcpInstallLines(file, mcp, copilotTarget(host), 'none')) {
    console.log(`${indent}${line}`);
  }
}

function printVscodeInstall(result: VscodeInstallResult, indent: string): void {
  const { paths } = result;
  printMcpInstall(paths.mcpConfig, result.mcp, VSCODE_MCP, indent);
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
    printMcpInstall(paths.mcpConfig, result.mcp, COPILOT_CLI_MCP, indent);
    console.log(`${indent}${INSTRUCTIONS_INSTALL_LINES[result.instructions](paths.instructions)}`);
  }
  for (const vscode of result.vscode) printVscodeInstall(vscode, indent);
  if (result.vscode.length > 0) console.log(`${indent}${VSCODE_HOOKS_LINE}`);
  console.log(`${indent}VS Code Copilot runs new hooks in a new chat session.`);
}

function copilotMcpRemoveLines(
  file: string,
  mcp: McpRemoveStatus | McpFailure,
  host: McpConfigHost,
): string[] {
  return mcp === 'absent' ? [] : mcpRemoveLines(file, mcp, copilotTarget(host));
}

export function printCopilotUninstall(result: CopilotUninstallResult): void {
  const { paths, mcp } = result;
  const lines: string[] = [];
  if (result.hooks) lines.push(`Removed hippo's Copilot hooks file ${paths.hooks}`);
  lines.push(...copilotMcpRemoveLines(paths.mcpConfig, mcp, COPILOT_CLI_MCP));
  lines.push(INSTRUCTIONS_REMOVE_LINES[result.instructions](paths.instructions));
  for (const vscode of result.vscode) {
    lines.push(...copilotMcpRemoveLines(vscode.paths.mcpConfig, vscode.mcp, VSCODE_MCP));
    lines.push(VSCODE_INSTRUCTIONS_REMOVE_LINES[vscode.instructions](vscode.paths.instructions));
  }
  const printed = lines.filter((line) => line !== '');
  for (const line of printed) console.log(line);
  if (printed.length === 0) {
    console.log('No hippo Copilot hooks, MCP server or instructions found.');
  }
}
