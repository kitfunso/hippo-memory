import type {
  McpConfigInstallResult,
  McpConfigUninstallResult,
} from '../hooks-install/mcp-config.js';
import { grokTableLines } from '../hooks-install/rules/grok-build.js';
import {
  hippoCommand,
  isMcpFailure,
  mcpServerSnippet,
  type McpConfigRow,
  type McpFailure,
  type McpMergeStatus,
  type McpRemoveStatus,
} from '../hooks-install/rules/mcp-config.js';
import { mcpFailureLine } from './copilot-report.js';

type Lines = (file: string, row: McpConfigRow) => string[];

function snippetLines(row: McpConfigRow, verb: 'add' | 'replace'): string[] {
  const what = verb === 'add' ? 'add this' : 'replace the entry with this';
  const { format } = row;
  return format.kind === 'json'
    ? [`${what} under "${format.host.key}" by hand: ${mcpServerSnippet(format.host)}`]
    : [`${what} table by hand:`, ...grokTableLines(hippoCommand())];
}

const unreadableReason = (row: McpConfigRow): string =>
  row.format.kind === 'json'
    ? 'has comments or is not a JSON object hippo can change'
    : 'is not a TOML file hippo can change';

const joinSnippet = (head: string, snippet: string[]): string[] => [
  `${head}; ${snippet[0]}`,
  ...snippet.slice(1),
];

const INSTALL_LINES = {
  added: (file) => [`Added the "hippo" MCP server -> ${file}`],
  present: (file) => [`The "hippo" MCP server is already in ${file}`],
  'user-owned': (file, row) =>
    joinSnippet(
      `Left the "hippo" MCP server in ${file} as it is: hippo did not write it`,
      snippetLines(row, 'replace'),
    ),
  unreadable: (file, row) =>
    joinSnippet(
      `WARNING: ${file} ${unreadableReason(row)}, so it was left unchanged`,
      snippetLines(row, 'add'),
    ),
} as const satisfies Record<McpMergeStatus, Lines>;

const REMOVE_LINES = {
  removed: (file) => [`Removed the "hippo" MCP server from ${file}`],
  absent: (file) => [`No hippo MCP server found in ${file}`],
  'user-owned': (file) => [`Left the "hippo" MCP server in ${file}: hippo did not write it`],
  unreadable: (file, row) => [
    `WARNING: ${file} ${unreadableReason(row)}, so it was left unchanged; ` +
      'remove the "hippo" server by hand if hippo added it',
  ],
} as const satisfies Record<McpRemoveStatus, Lines>;

function failureLines(file: string, failure: McpFailure, fix: string[]): string[] {
  return [mcpFailureLine(file, failure, fix[0]), ...fix.slice(1)];
}

function mcpConfigInstallLines(result: McpConfigInstallResult, row: McpConfigRow): string[] {
  const { file, status } = result;
  return isMcpFailure(status)
    ? failureLines(file, status, snippetLines(row, 'add'))
    : INSTALL_LINES[status](file, row);
}

function mcpConfigUninstallLines(result: McpConfigUninstallResult, row: McpConfigRow): string[] {
  const { file, status } = result;
  return isMcpFailure(status)
    ? failureLines(file, status, ['remove the "hippo" server by hand if hippo added it'])
    : REMOVE_LINES[status](file, row);
}

export function printMcpConfigInstall(
  result: McpConfigInstallResult,
  row: McpConfigRow,
  indent: string,
): void {
  for (const line of mcpConfigInstallLines(result, row)) console.log(`${indent}${line}`);
}

export function printMcpConfigUninstall(result: McpConfigUninstallResult, row: McpConfigRow): void {
  for (const line of mcpConfigUninstallLines(result, row)) console.log(line);
}
