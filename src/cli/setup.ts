// `hippo hook`, `hippo setup` and `hippo daily-runner`: install and run the agent and machine integrations.

import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { installJsonHooks, uninstallJsonHooks, checkUninstallable, resolveJsonHookPaths } from '../hooks/json-hooks.js';
import { detectInstalledTools, type JsonHookTarget, type ToolDetection } from '../hooks/shared.js';
import {
  ensureCodexWrapperInstalled,
  installCodexWrapper,
  detectRealCodexPath,
  uninstallCodexWrapper,
} from '../hooks/codex-wrapper.js';
import { installOpencodePlugin, uninstallOpencodePlugin, resolveOpencodePluginPath } from '../hooks/opencode.js';
import { type CopilotInstallResult, type CopilotUninstallResult, type InstructionsInstallStatus, type InstructionsRemoveStatus, type McpFailure, type McpMergeStatus, copilotMcpSnippet, copilotPaths, installCopilot, isMcpFailure, uninstallCopilot } from '../hooks/copilot.js';
import { isInitialized } from '../store/open.js';
import { currentMachine, importUserMemories } from '../agent-memories/sync.js';
import { getGlobalRoot } from '../shared.js';
import { listRegisteredWorkspaces, runDailyMaintenance } from '../scheduler.js';
import { replayCompactionsAt } from '../compaction-record.js';
import { log } from '../log.js';
import { printError } from './output.js';
import { printAgentImport, installCodexMemoryHooks, setupDailySchedule, warnClaudeSettingsUnusable } from './shared.js';
import { repairQualityOnceAt } from './quality-repair-once.js';
import { HOOK_MARKERS, HOOKS, hippoBlock, withoutHookBlock } from './hook-blocks.js';
import { escapeRegex } from '../escape.js';

// ---------------------------------------------------------------------------
// Hook install/uninstall
// ---------------------------------------------------------------------------

export function cmdHook(args: string[]): void {
  const subcommand = args[0];
  const target = args[1];
  if (subcommand === 'list') return hookList();
  if (subcommand === 'install') return hookInstall(target);
  if (subcommand === 'uninstall') return hookUninstall(target);

  printError('Usage: hippo hook <install|uninstall|list> [target]');
  process.exit(1);
}

type HookSpec = (typeof HOOKS)[string];

// Cursor has no init row, so the AGENTS.md block is usually another agent's, and Cursor reads that one as it is.
function othersBlock(target: string, text: string): boolean {
  return target === 'cursor' && hippoBlock(text)?.owner !== 'cursor';
}

function hookList(): void {
  console.log('Available hooks:\n');
  for (const [name, hook] of Object.entries(HOOKS)) {
    console.log(`  ${name.padEnd(15)} -> ${hook.file} (${hook.description})`);
  }
  console.log(`  ${'copilot'.padEnd(15)} -> $COPILOT_HOME or ~/.copilot (GitHub Copilot: hooks, MCP server and instructions)`);
  console.log('\nUsage: hippo hook install <name>');
  console.log('       hippo hook uninstall <name>');
}

function hookInstall(target: string | undefined): void {
  // Copilot's instructions live in its home folder, not in a project file, so it has no HOOKS entry.
  if (target === 'copilot') return printCopilotInstall(installCopilot(), '');
  if (!target || !HOOKS[target]) {
    printError(`Unknown hook target: ${target ?? '(none)'}`);
    printError(`   Available: ${[...Object.keys(HOOKS), 'copilot'].join(', ')}`);
    process.exit(1);
  }
  const hook = HOOKS[target];
  patchAgentFile(hook, target);

  // For Claude Code, also install SessionEnd+SessionStart entries in its
  // settings file.
  if (target === 'claude-code') {
    printClaudeHookInstall(installJsonHooks(target));
  } else if (target === 'opencode') {
    installOpencodeHook();
  } else if (target === 'codex') {
    installCodexMemoryHooks('');
    // The wrapper stays the capture path; the hooks above work without it, so a missing launcher is not an error.
    if (detectRealCodexPath()) {
      const result = installCodexWrapper();
      console.log(`Installed Codex session-end integration -> ${result.metadataPath}`);
      console.log(`   Wrapped detected Codex launcher at ${result.commandPath}`);
    } else {
      console.log('No codex launcher on PATH, so session-end capture was not set up; re-run once `codex` is on PATH.');
    }
  }
}

function patchAgentFile(hook: HookSpec, target: string): void {
  const filepath = path.resolve(process.cwd(), hook.file);

  const block = `${HOOK_MARKERS.start}\n${hook.content}\n${HOOK_MARKERS.end}`;

  if (fs.existsSync(filepath)) {
    const existing = fs.readFileSync(filepath, 'utf8');

    if (existing.includes(HOOK_MARKERS.start) && othersBlock(target, existing)) {
      console.log(`${hook.file} already has a hippo block, which Cursor reads; left it as is.`);
    } else if (existing.includes(HOOK_MARKERS.start)) {
      const re = new RegExp(
        `${escapeRegex(HOOK_MARKERS.start)}[\\s\\S]*?${escapeRegex(HOOK_MARKERS.end)}`,
        'g',
      );
      const updated = existing.replace(re, block);
      fs.writeFileSync(filepath, updated, 'utf8');
      console.log(`Updated Hippo hook in ${hook.file}`);
    } else {
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(filepath, existing + sep + block + '\n', 'utf8');
      console.log(`Installed Hippo hook in ${hook.file} (appended)`);
    }
  } else {
    // Do not create a new agent-instructions file (CLAUDE.md, AGENTS.md, etc.) in directories that don't already have one —
    // avoids polluting cwd with files the user didn't ask for. The settings.json hook below is still installed for
    // claude-code, so the consolidation hook still runs.
    console.log(
      `${hook.file} not found in ${process.cwd()} — skipping agent-instructions patch.`,
    );
    console.log(`   Create ${hook.file} and re-run \`hippo hook install ${target}\` if you want the agent prompt.`);
  }
}

function printClaudeHookInstall(result: ReturnType<typeof installJsonHooks>): void {
  warnClaudeSettingsUnusable(result, '');
  if (result.installedSessionEnd) {
    console.log(`Installed hippo session-end SessionEnd hook in ${result.target} settings`);
  }
  if (result.installedSessionStart) {
    console.log(`Installed hippo last-sleep SessionStart hook in ${result.target} settings`);
  }
  if (result.installedUserPromptSubmit) {
    console.log(`Installed hippo pinned-inject UserPromptSubmit hook in ${result.target} settings`);
  }
  if (result.installedPreCompact) {
    console.log(`Installed hippo pre-compact PreCompact hook in ${result.target} settings`);
  }
  if (result.installedCompactResume) {
    console.log(`Installed hippo compact-resume SessionStart(compact) hook in ${result.target} settings`);
  }
  if (result.installedPostCompact) {
    console.log(`Installed hippo post-compact PostCompact hook in ${result.target} settings`);
  }
  if (result.installedCaptureError) {
    console.log(`Installed hippo capture-error PostToolUseFailure hook in ${result.target} settings`);
  }
  if (result.migratedFromStop) {
    console.log(`Migrated legacy Stop hook → SessionEnd (was running every turn; now fires once on session exit)`);
  }
  if (result.migratedSplitSessionEnd) {
    console.log(`Migrated split sleep+capture SessionEnd entries → single detached hippo session-end`);
  } else if (result.migratedLegacySessionEnd) {
    console.log(`Migrated legacy SessionEnd entry to the new detached form`);
  }
}

function installOpencodeHook(): void {
  // opencode uses a TS plugin, not JSON hooks. See src/hooks.ts.
  const result = installOpencodePlugin();
  if (result.installed) {
    console.log(`Installed hippo opencode plugin at ${result.pluginPath}`);
  } else {
    console.log(`opencode plugin already up to date at ${result.pluginPath}`);
  }
  if (result.migratedLegacyHooks) {
    console.log(`Removed legacy Claude Code-style hooks block from opencode.json — opencode can now launch`);
  }
  if (result.jsonRepairFailed) {
    console.log(`WARNING: opencode.json is unparseable; legacy hooks block could not be auto-removed. Fix the file manually.`);
  }
}

const MCP_MERGE_LINES = {
  added: (file: string) => `Added the "hippo" MCP server -> ${file}`,
  present: (file: string) => `The "hippo" MCP server is already in ${file}`,
  'user-owned': (file: string) => `Left the "hippo" MCP server in ${file} as it is: hippo did not write it`,
  unreadable: (file: string) => `WARNING: ${file} has comments or is not a JSON object hippo can merge into, so it was left unchanged; add this under "mcpServers" by hand: ${copilotMcpSnippet()}`,
} as const satisfies Record<McpMergeStatus, (file: string) => string>;

const mcpFailureLine = (file: string, failure: McpFailure, fix: string): string => `WARNING: hippo could not use ${file} (${failure.failed}), so it was left unchanged; ${fix}`;
const unclosedLine = (file: string): string => `WARNING: ${file} has ${HOOK_MARKERS.start} with no ${HOOK_MARKERS.end}, so hippo left it unchanged; fix the markers by hand`;

const INSTRUCTIONS_INSTALL_LINES = {
  written: (file: string) => `Wrote the hippo block -> ${file}`,
  present: (file: string) => `The hippo block is already in ${file}`,
  kept: (file: string) => `Kept the hippo block in ${file} as it is: it is not the Copilot text hippo wrote, so it was edited or is another agent's`,
  unclosed: unclosedLine,
} as const satisfies Record<InstructionsInstallStatus, (file: string) => string>;

const INSTRUCTIONS_REMOVE_LINES = {
  removed: (file: string) => `Removed the hippo block from ${file}`,
  absent: () => '',
  kept: (file: string) => `Left the hippo block in ${file}: it is not the Copilot text hippo wrote. Delete it by hand if no agent needs it.`,
  unclosed: unclosedLine,
} as const satisfies Record<InstructionsRemoveStatus, (file: string) => string>;

function printCopilotInstall(result: CopilotInstallResult, indent: string): void {
  const { paths, mcp } = result;
  const hooks = result.hooks ? "Installed hippo's Copilot hooks (sessionStart, postToolUseFailure, preCompact, sessionEnd) ->" : "hippo's Copilot hooks are already in";
  console.log(`${indent}${hooks} ${paths.hooks}`);
  const mcpLine = isMcpFailure(mcp) ? mcpFailureLine(paths.mcpConfig, mcp, `add this under "mcpServers" by hand: ${copilotMcpSnippet()}`) : MCP_MERGE_LINES[mcp](paths.mcpConfig);
  console.log(`${indent}${mcpLine}`);
  console.log(`${indent}${INSTRUCTIONS_INSTALL_LINES[result.instructions](paths.instructions)}`);
  console.log(`${indent}VS Code Copilot runs new hooks in a new chat session.`);
}

function printCopilotUninstall(result: CopilotUninstallResult): void {
  const { paths, mcp } = result;
  if (result.hooks) console.log(`Removed hippo's Copilot hooks file ${paths.hooks}`);
  if (isMcpFailure(mcp)) console.log(mcpFailureLine(paths.mcpConfig, mcp, 'remove the "hippo" server by hand if hippo added it'));
  if (mcp === 'removed') console.log(`Removed the "hippo" MCP server from ${paths.mcpConfig}`);
  if (mcp === 'user-owned') console.log(`Left the "hippo" MCP server in ${paths.mcpConfig}: hippo did not write it`);
  if (mcp === 'unreadable') console.log(`WARNING: ${paths.mcpConfig} has comments or is not a JSON object hippo can edit, so it was left unchanged; remove the "hippo" server by hand if hippo added it`);
  const instructions = INSTRUCTIONS_REMOVE_LINES[result.instructions](paths.instructions);
  if (instructions) console.log(instructions);
  if (!result.hooks && mcp === 'absent' && result.instructions === 'absent') console.log('No hippo Copilot hooks, MCP server or instructions block found.');
}

function hookUninstall(target: string | undefined): void {
  if (target === 'copilot') return printCopilotUninstall(uninstallCopilot());
  if (!target || !HOOKS[target]) {
    printError(`Unknown hook target: ${target ?? '(none)'}`);
    process.exit(1);
  }
  unpatchAgentFile(HOOKS[target], target);

  // For Claude Code, also strip its SessionEnd/SessionStart entries.
  if (target === 'claude-code') {
    if (uninstallJsonHooks(target)) {
      console.log(`Removed hippo hooks from ${target} settings`);
    } else {
      warnClaudeSettingsUnusable(checkUninstallable(target), '', 'uninstall');
    }
  } else if (target === 'opencode') {
    // opencode uses a TS plugin; uninstall removes the plugin file AND
    // also runs the legacy-hooks migration so the downgrade/remove path
    // leaves opencode launchable.
    if (uninstallOpencodePlugin()) {
      console.log(`Removed hippo opencode plugin (and any legacy hooks block from opencode.json)`);
    }
  } else if (target === 'codex') {
    if (uninstallJsonHooks('codex')) {
      console.log(`Removed hippo's Codex memory hooks from ${resolveJsonHookPaths('codex').settings}`);
    }
    if (uninstallCodexWrapper()) {
      console.log('Removed Codex wrapper integration');
    }
  } else if (target === 'cursor') {
    removeLegacyCursorRules();
  }
}

function unpatchAgentFile(hook: HookSpec, target: string): void {
  const filepath = path.resolve(process.cwd(), hook.file);
  if (!fs.existsSync(filepath)) {
    console.log(`${hook.file} not found, skipping agent-instructions uninstall.`);
    return;
  }
  const existing = fs.readFileSync(filepath, 'utf8');
  if (existing.includes(HOOK_MARKERS.start) && othersBlock(target, existing)) {
    const owner = hippoBlock(existing)?.owner;
    const whose = owner ? `hippo wrote it for ${owner}` : 'it has been edited, so hippo cannot tell whose it is';
    console.log(`Left the hippo block in ${hook.file}: ${whose}. Delete it by hand if no agent needs it.`);
  } else if (existing.includes(HOOK_MARKERS.start)) {
    fs.writeFileSync(filepath, withoutHookBlock(existing) + '\n', 'utf8');
    console.log(`Removed Hippo hook from ${hook.file}`);
  } else {
    console.log(`No Hippo hook found in ${hook.file}.`);
  }
}

// Older hippo wrote Cursor's block to .cursorrules, creating the file when it was missing.
function removeLegacyCursorRules(): void {
  const legacy = path.resolve(process.cwd(), '.cursorrules');
  const old = fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8') : '';
  if (old.includes(HOOK_MARKERS.start)) {
    const left = withoutHookBlock(old);
    if (left) fs.writeFileSync(legacy, left + '\n', 'utf8');
    else fs.unlinkSync(legacy);
    console.log(left ? 'Removed the old Hippo hook from .cursorrules' : 'Deleted .cursorrules, which held only the old Hippo hook');
  }
}

// `hippo setup` -- one-shot configuration for every AI coding tool on the box.
// Detection and install logic live in ./hooks.ts.

export function cmdSetup(flags: Record<string, string | boolean | string[]>): void {
  const dryRun = Boolean(flags['dry-run']);
  const forceAll = Boolean(flags['all']);
  const tools = detectInstalledTools();
  const globalRoot = getGlobalRoot();

  console.log('Hippo setup -- configuring SessionEnd + SessionStart hooks');
  console.log('');

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
    console.log('Markdown-only tools (no hook API — run `hippo hook install <name>` inside a project):');
    for (const tool of markdownTools) {
      console.log(`  ${tool.name.padEnd(14)} ${tool.notes}`);
    }
  }

  if (!flags['no-schedule']) {
    console.log('');
    if (dryRun) {
      console.log(`[dry-run] would install the machine-level daily runner around ${globalRoot}`);
    } else {
      setupDailySchedule(globalRoot);
    }
  }

  if (!flags['no-learn']) {
    console.log('');
    printAgentImport(importUserMemories(globalRoot, { machine: currentMachine(), dryRun }), dryRun ? '[dry-run] ' : '');
  }

  console.log('');
  console.log('Done. Restart your AI tool to activate the hooks.');
}

function setupCopilot(dryRun: boolean): void {
  const indent = `  ${'copilot'.padEnd(14)} `;
  if (!dryRun) return printCopilotInstall(installCopilot(), indent);
  const { hooks, mcpConfig, instructions } = copilotPaths();
  console.log(`[dry-run] would install hooks in ${hooks}, the MCP server in ${mcpConfig} and the hippo block in ${instructions}`);
}

function setupJsonTool(tool: ToolDetection, dryRun: boolean): void {
  if (tool.name === 'copilot') return setupCopilot(dryRun);
  if (dryRun) {
    // Resolve the real settings path so the filename is right for each tool
    // (claude-code -> settings.json, opencode -> opencode.json).
    const { settings } = resolveJsonHookPaths(tool.name as JsonHookTarget);
    console.log(`[dry-run] would install hooks in ${settings}`);
    return;
  }
  const result = installJsonHooks(tool.name as JsonHookTarget);
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
    if (tool.name === 'codex') console.log(`[dry-run] would install Codex memory hooks in ${resolveJsonHookPaths('codex').settings}`);
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
  } else {
    console.log(`  ${tool.name.padEnd(14)} not found on PATH -- skipping`);
  }
}

function setupPluginTool(tool: ToolDetection, dryRun: boolean): void {
  if (tool.name !== 'opencode') {
    // Other plugin tools (openclaw) have their own installer; the notes
    // line points the user at it.
    console.log(`  ${tool.name.padEnd(14)} ${tool.notes}`);
    return;
  }
  if (dryRun) {
    console.log(`  ${tool.name.padEnd(14)} [dry-run] would install hippo plugin at ${resolveOpencodePluginPath()}`);
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

export function cmdDailyRunner(): void {
  const globalRoot = getGlobalRoot();
  // No workspace sleep ever opens the global store, yet hooks in folders without a store compact into it.
  if (isInitialized(globalRoot)) {
    const finished = replayCompactionsAt(globalRoot, (message) => log.warn(`compaction replay: ${message}`));
    if (finished > 0) console.log(`Finished saving ${finished} compaction${finished === 1 ? '' : 's'} left over in the global store.`);
    repairQualityOnceAt(globalRoot);
  }
  printAgentImport(importUserMemories(globalRoot, { machine: currentMachine() }), '');
  const workspaces = listRegisteredWorkspaces(globalRoot);

  if (workspaces.length === 0) {
    console.log('No registered Hippo workspaces found. Run `hippo init` inside a project first.');
    return;
  }

  console.log(`Running daily maintenance across ${workspaces.length} registered workspace${workspaces.length === 1 ? '' : 's'}...`);

  let processed = 0;
  let failed = 0;
  runDailyMaintenance(workspaces, (cwd, args) => {
    try {
      execFileSync(process.execPath, [process.argv[1], ...args], {
        cwd,
        stdio: 'inherit',
        windowsHide: true,
      });
      if (args[0] === 'sleep') processed++;
    } catch (err) {
      failed++;
      const action = args.join(' ');
      log.error(`daily-runner failed in ${cwd} during \`${action}\`: ${(err as Error).message}`);
    }
  });

  console.log(`Daily maintenance complete: ${processed} workspace${processed === 1 ? '' : 's'} processed, ${failed} command failure${failed === 1 ? '' : 's'}.`);
}
