import { isFileSystemError } from '../../base/util/expected-errors.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { processHomes } from '../../host/agent-homes.js';
import { installCopilot, isCopilotCliPresent, uninstallCopilot } from '../hooks-install/copilot.js';
import {
  installMcpConfigHost,
  isMcpConfigHostPresent,
  uninstallMcpConfigHost,
} from '../hooks-install/mcp-config.js';
import { MCP_CONFIG_HOSTS, type McpConfigRow } from '../hooks-install/rules/mcp-config.js';
import { printCopilotInstall, printCopilotUninstall } from './copilot-report.js';
import { printMcpConfigInstall, printMcpConfigUninstall } from './mcp-config-report.js';

export interface HomeTarget {
  readonly name: string;
  readonly listLine: () => string;
  readonly initPresent?: () => boolean;
  readonly install: (indent: string) => void;
  readonly uninstall: () => void;
}

const COPILOT_TARGET: HomeTarget = {
  name: 'copilot',
  listLine: () =>
    `  ${'copilot'.padEnd(15)} -> $COPILOT_HOME or ~/.copilot, and each VS Code User folder ` +
    '(GitHub Copilot: hooks, MCP server and instructions)',
  initPresent: isCopilotCliPresent,
  install: (indent) => printCopilotInstall(installCopilot(), indent),
  uninstall: () => printCopilotUninstall(uninstallCopilot()),
};

function mcpConfigTarget(row: McpConfigRow): HomeTarget {
  return {
    name: row.name,
    listLine: () =>
      `  ${row.name.padEnd(15)} -> ${row.file(processHomes())} (${row.label}: the hippo MCP server)`,
    initPresent: () => isMcpConfigHostPresent(row, processHomes()),
    install: (indent) =>
      printMcpConfigInstall(installMcpConfigHost(row, processHomes()), row, indent),
    uninstall: () => printMcpConfigUninstall(uninstallMcpConfigHost(row, processHomes()), row),
  };
}

export const HOME_TARGETS: readonly HomeTarget[] = [
  COPILOT_TARGET,
  ...MCP_CONFIG_HOSTS.map(mcpConfigTarget),
];

export function homeTarget(name: string): HomeTarget | undefined {
  return HOME_TARGETS.find((target) => target.name === name);
}

function installForInit(target: HomeTarget, indent: string): void {
  try {
    if (target.initPresent?.() !== true) return;
    target.install(indent);
  } catch (err) {
    if (!isFileSystemError(err)) throw err;
    log.warn(
      `init did not finish the ${target.name} files, so some may be missing: ${errorMessage(err)}. ` +
        `Fix that, then run \`hippo hook install ${target.name}\`.`,
      errorFields(err),
    );
  }
}

export function installHomeTargetsForInit(indent: string): void {
  for (const target of HOME_TARGETS) installForInit(target, indent);
}
