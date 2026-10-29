// `hippo setup`: detect the agent tools on this machine and wire each one.

import { installJsonHooks, resolveJsonHookPaths } from '../hooks-install/json-hooks.js';
import type { JsonHookTarget, ToolDetection } from '../hooks-install/rules/shared.js';
import { detectInstalledTools } from '../hooks-install/detect.js';
import { ensureCodexWrapperInstalled } from '../hooks-install/codex-wrapper.js';
import { installOpencodePlugin, resolveOpencodePluginPath } from '../hooks-install/opencode.js';
import { copilotPaths, installCopilot, isCopilotCliPresent } from '../hooks-install/copilot.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { importUserMemories } from '../../api/agent-memories.js';
import { currentMachine } from '../../infra/machine.js';
import { boolFlag, type CommandContext } from './flag-values.js';
import { printAgentImport } from './print.js';
import {
  installCodexMemoryHooks,
  setupDailySchedule,
  warnClaudeSettingsUnusable,
} from './install-steps.js';
import { printCopilotInstall } from './copilot-report.js';

function setupDetectedTools(
  tools: ReturnType<typeof detectInstalledTools>,
  forceAll: boolean,
  dryRun: boolean,
): void {
  const jsonTools = tools.filter((t) => t.kind === 'json-hook' && (t.detected || forceAll));
  const wrapperTools = tools.filter((t) => t.kind === 'wrapper' && (t.detected || forceAll));
  const skipped = tools.filter((t) => t.kind === 'json-hook' && !t.detected && !forceAll);
  const markdownTools = tools.filter((t) => t.kind === 'markdown-instruction' && t.detected);
  const pluginTools = tools.filter((t) => t.kind === 'plugin' && t.detected);

  if (jsonTools.length === 0 && !forceAll) {
    console.log('No JSON-hook-capable tools detected (checked: claude-code, copilot).');
    console.log('Run with --all to install hooks anyway.');
  }

  for (const tool of jsonTools) setupJsonTool(tool, dryRun);

  for (const tool of skipped) {
    console.log(`  ${tool.name.padEnd(14)} not detected at ${tool.configDir} -- skipping`);
  }

  for (const tool of wrapperTools) setupWrapperTool(tool, dryRun);

  if (pluginTools.length > 0) {
    console.log('');
    console.log('Plugin-based tools (hook API via plugin, not JSON):');
    for (const tool of pluginTools) setupPluginTool(tool, dryRun);
  }

  if (markdownTools.length > 0) {
    console.log('');
    console.log(
      'Markdown-only tools (no hook API — run `hippo hook install <name>` inside a project):',
    );
    for (const tool of markdownTools) {
      console.log(`  ${tool.name.padEnd(14)} ${tool.notes}`);
    }
  }
}

// `hippo setup` -- one-shot configuration for every AI coding tool on the box.
// Detection and install logic live in src/surface/hooks-install/.

export async function handleSetup({ tenantId, flags, cli }: CommandContext): Promise<void> {
  const dryRun = boolFlag(flags, 'dry-run');
  const forceAll = boolFlag(flags, 'all');
  const tools = detectInstalledTools();
  const globalRoot = hippoHomeDir();

  console.log('Hippo setup -- configuring SessionEnd + SessionStart hooks');
  console.log('');

  setupDetectedTools(tools, forceAll, dryRun);

  if (!boolFlag(flags, 'no-schedule')) {
    console.log('');
    if (dryRun) {
      console.log(`[dry-run] would install the machine-level daily runner around ${globalRoot}`);
    } else {
      setupDailySchedule(globalRoot);
    }
  }

  if (!boolFlag(flags, 'no-learn')) {
    console.log('');
    const imported = await importUserMemories(
      globalRoot,
      cli.syncOptions(tenantId, currentMachine(), { dryRun }),
    );
    printAgentImport(imported, dryRun ? '[dry-run] ' : '');
  }

  console.log('');
  console.log('Done. Restart your AI tool to activate the hooks.');
}

function setupCopilot(dryRun: boolean): void {
  const indent = `  ${'copilot'.padEnd(14)} `;
  if (!dryRun) return printCopilotInstall(installCopilot(), indent);
  const { hooks, mcpConfig, instructions, vscode } = copilotPaths();
  const cliFiles = isCopilotCliPresent()
    ? `, the MCP server in ${mcpConfig} and the hippo block in ${instructions}`
    : '';
  console.log(`[dry-run] would install hooks in ${hooks}${cliFiles}`);
  for (const dir of vscode) {
    console.log(
      `[dry-run] would add the MCP server to ${dir.mcpConfig} and write ${dir.instructions}`,
    );
  }
}

function setupJsonTool(tool: ToolDetection, dryRun: boolean): void {
  if (tool.name === 'copilot') return setupCopilot(dryRun);
  // SAFETY: detectInstalledTools gives kind 'json-hook' only to claude-code and copilot
  // (rules/shared.ts), and copilot returned above.
  const target = tool.name as JsonHookTarget;
  if (dryRun) {
    // Resolve the real settings path so the filename is right for each tool (claude-code ->
    // settings.json, opencode -> opencode.json).
    const { settings } = resolveJsonHookPaths(target);
    console.log(`[dry-run] would install hooks in ${settings}`);
    return;
  }
  const result = installJsonHooks(target);
  if (warnClaudeSettingsUnusable(result, `  ${tool.name.padEnd(14)} `)) return;
  const bits: string[] = [];
  if (result.installedSessionEnd) bits.push('SessionEnd (session-end)');
  if (result.installedSessionStart) bits.push('SessionStart');
  if (result.installedUserPromptSubmit) bits.push('UserPromptSubmit (pinned-inject)');
  if (result.installedPreCompact) bits.push('PreCompact (pre-compact)');
  if (result.installedCompactResume) bits.push('SessionStart(compact) (compact-resume)');
  if (result.installedPostCompact) bits.push('PostCompact (post-compact)');
  if (result.installedCaptureError) bits.push('PostToolUseFailure (capture-error)');
  if (result.migratedFromStop) bits.push('migrated legacy Stop');
  if (result.migratedSplitSessionEnd) bits.push('migrated split SessionEnd → session-end');
  else if (result.migratedLegacySessionEnd) bits.push('migrated legacy SessionEnd');
  if (bits.length === 0) {
    console.log(`  ${tool.name.padEnd(14)} already configured (${result.settingsPath})`);
  } else {
    console.log(`  ${tool.name.padEnd(14)} ${bits.join(', ')} -> ${result.settingsPath}`);
  }
}

function setupWrapperTool(tool: ToolDetection, dryRun: boolean): void {
  if (dryRun) {
    if (tool.name === 'codex') {
      console.log(
        `[dry-run] would install Codex memory hooks in ${resolveJsonHookPaths('codex').settings}`,
      );
    }
    console.log(`[dry-run] would wrap the detected ${tool.name} launcher in place`);
    return;
  }
  if (tool.name !== 'codex') return;
  installCodexMemoryHooks(`  ${tool.name.padEnd(14)} `);
  const result = ensureCodexWrapperInstalled();
  if (result.status === 'installed') {
    console.log(`  ${tool.name.padEnd(14)} wrapped launcher -> ${result.commandPath}`);
  } else if (result.status === 'already-installed') {
    console.log(`  ${tool.name.padEnd(14)} already wrapped -> ${result.commandPath}`);
  } else if (result.status === 'foreign-metadata') {
    console.log(
      `  ${tool.name.padEnd(14)} left alone: ${result.metadataPath} was not written by hippo`,
    );
  } else {
    console.log(`  ${tool.name.padEnd(14)} not found on PATH -- skipping`);
  }
}

function setupPluginTool(tool: ToolDetection, dryRun: boolean): void {
  if (tool.name !== 'opencode') {
    // Other plugin tools (openclaw) have their own installer; the notes line points the user at it.
    console.log(`  ${tool.name.padEnd(14)} ${tool.notes}`);
    return;
  }
  if (dryRun) {
    console.log(
      `  ${tool.name.padEnd(14)} [dry-run] would install hippo plugin at ${resolveOpencodePluginPath()}`,
    );
    return;
  }
  const result = installOpencodePlugin();
  const bits: string[] = [];
  if (result.installed) bits.push('installed plugin');
  if (result.migratedLegacyHooks) bits.push('migrated legacy hooks block');
  if (result.jsonRepairFailed) bits.push('WARNING: opencode.json unparseable — manual fix needed');
  if (bits.length === 0) {
    console.log(`  ${tool.name.padEnd(14)} already configured (${result.pluginPath})`);
  } else {
    console.log(`  ${tool.name.padEnd(14)} ${bits.join(', ')} -> ${result.pluginPath}`);
  }
}
