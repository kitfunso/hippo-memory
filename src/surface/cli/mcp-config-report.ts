import type {
  McpConfigInstallResult,
  McpConfigUninstallResult,
} from '../hooks-install/mcp-config.js';
import { grokTableLines } from '../hooks-install/rules/grok-build.js';
import {
  hippoCommand,
  isMcpFailure,
  mcpServerSnippet,
  type McpConfigFormat,
  type McpConfigRow,
  type McpFailure,
  type McpMergeStatus,
  type McpRemoveStatus,
} from '../hooks-install/rules/mcp-config.js';

export type McpReportTarget = Pick<McpConfigRow, 'name' | 'format'>;
export type McpPaste = 'snippet' | 'hint' | 'none';

type Lines = (file: string, target: McpReportTarget, paste: McpPaste) => string[];

function snippetLines(format: McpConfigFormat, verb: 'add' | 'replace'): string[] {
  const what = verb === 'add' ? 'add this' : 'replace the entry with this';
  return format.kind === 'json'
    ? [`${what} under "${format.host.key}" by hand: ${mcpServerSnippet(format.host)}`]
    : [`${what} table by hand:`, ...grokTableLines(hippoCommand())];
}

function pasteLines(target: McpReportTarget, paste: McpPaste): string[] {
  if (paste === 'snippet') return snippetLines(target.format, 'replace');
  if (paste === 'hint') {
    return [`run \`hippo hook install ${target.name}\` to see the entry to paste`];
  }
  return [];
}

const unreadableReason = (format: McpConfigFormat): string =>
  format.kind === 'json'
    ? 'has comments or is not a JSON object hippo can change'
    : 'is not a TOML file hippo can change safely';

const addIfNoServer = (format: McpConfigFormat): string[] =>
  format.kind === 'json'
    ? snippetLines(format, 'add')
    : [
        `add a "hippo" server under mcp_servers by hand, with command = "${hippoCommand()}" ` +
          'and args = ["mcp"]',
      ];

const invalidReason = (format: McpConfigFormat): string =>
  (format.kind === 'json' ? format.host.invalid?.({}) : null) ?? 'is not a config the host accepts';

const withTail = (head: string, tail: string[]): string[] =>
  tail.length === 0 ? [head] : [`${head}; ${tail[0]}`, ...tail.slice(1)];

export const mcpFailureLine = (file: string, failure: McpFailure, fix: string): string =>
  `WARNING: hippo could not use ${file} (${failure.failed}), so it was left unchanged; ${fix}`;

const INSTALL_LINES = {
  added: (file) => [`Added the "hippo" MCP server -> ${file}`],
  present: (file) => [`The "hippo" MCP server is already in ${file}`],
  kept: (file) => [`hippo's MCP server is already in ${file}, set up by hand; left as it is`],
  'user-owned': (file, target, paste) =>
    withTail(
      `Left the "hippo" MCP server in ${file} as it is: hippo did not write it`,
      pasteLines(target, paste),
    ),
  unreadable: (file, target) => {
    const [add, ...snippet] = addIfNoServer(target.format);
    const head = `WARNING: ${file} ${unreadableReason(target.format)}, so it was left unchanged`;
    return [`${head}; if it has no hippo server, ${add}`, ...snippet];
  },
  invalid: (file, target) => [
    `WARNING: ${file} was left unchanged: it ${invalidReason(target.format)}. ` +
      `Then run \`hippo hook install ${target.name}\``,
  ],
} as const satisfies Record<McpMergeStatus, Lines>;

const REMOVE_BY_HAND = 'remove the "hippo" server by hand if hippo added it';

const REMOVE_LINES = {
  removed: (file) => [`Removed the "hippo" MCP server from ${file}`],
  absent: (file) => [`No hippo MCP server found in ${file}`],
  kept: (file) => [
    `Left hippo's MCP server in ${file}: it was set up by hand, ` +
      'so remove it by hand if you want it gone',
  ],
  'user-owned': (file) => [`Left the "hippo" MCP server in ${file}: hippo did not write it`],
  unreadable: (file, target) => [
    `WARNING: ${file} ${unreadableReason(target.format)}, so it was left unchanged; ${REMOVE_BY_HAND}`,
  ],
} as const satisfies Record<McpRemoveStatus, Lines>;

export function mcpInstallLines(
  file: string,
  status: McpMergeStatus | McpFailure,
  target: McpReportTarget,
  paste: McpPaste,
): string[] {
  if (!isMcpFailure(status)) return INSTALL_LINES[status](file, target, paste);
  const fix = snippetLines(target.format, 'add');
  return [mcpFailureLine(file, status, fix[0]), ...fix.slice(1)];
}

export function mcpRemoveLines(
  file: string,
  status: McpRemoveStatus | McpFailure,
  target: McpReportTarget,
): string[] {
  if (isMcpFailure(status)) return [mcpFailureLine(file, status, REMOVE_BY_HAND)];
  return REMOVE_LINES[status](file, target);
}

export function printMcpConfigInstall(
  result: McpConfigInstallResult,
  row: McpConfigRow,
  indent: string,
  explicit: boolean,
): void {
  const paste = explicit ? 'snippet' : 'hint';
  for (const line of mcpInstallLines(result.file, result.status, row, paste)) {
    console.log(`${indent}${line}`);
  }
}

export function printMcpConfigUninstall(result: McpConfigUninstallResult, row: McpConfigRow): void {
  for (const line of mcpRemoveLines(result.file, result.status, row)) console.log(line);
}
