// `hippo hook`: install or remove one agent's hippo block and hooks.

import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  checkUninstallable,
  installJsonHooks,
  resolveJsonHookPaths,
  uninstallJsonHooks,
} from '../hooks-install/json-hooks.js';
import {
  installCodexWrapper,
  detectRealCodexPath,
  uninstallCodexWrapper,
} from '../hooks-install/codex-wrapper.js';
import { installOpencodePlugin, uninstallOpencodePlugin } from '../hooks-install/opencode.js';
import { installCopilot, uninstallCopilot } from '../hooks-install/copilot.js';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { printError } from './output.js';
import { type CommandContext } from './flag-values.js';
import { installCodexMemoryHooks, warnClaudeSettingsUnusable } from './install-steps.js';
import {
  appendHookBlock,
  hookBlock,
  HOOK_MARKERS,
  HOOKS,
  hippoBlock,
  withoutHookBlock,
  type HookSpec,
} from '../hooks-install/instructions.js';
import { escapeRegex } from '../../base/util/escape.js';
import { fail } from './exit.js';
import { printCopilotInstall, printCopilotUninstall } from './copilot-report.js';

export function handleHook({ args }: CommandContext): void {
  const subcommand = args[0];
  const target = args[1];
  if (subcommand === 'list') return hookList();
  if (subcommand === 'install') return hookInstall(target);
  if (subcommand === 'uninstall') return hookUninstall(target);

  fail('Usage: hippo hook <install|uninstall|list> [target]');
}

// Cursor has no init row, so the AGENTS.md block is usually another agent's, and Cursor reads that
// one as it is.
function othersBlock(target: string, text: string): boolean {
  return target === 'cursor' && hippoBlock(text)?.owner !== 'cursor';
}

function hookList(): void {
  console.log('Available hooks:\n');
  for (const [name, hook] of Object.entries(HOOKS)) {
    console.log(`  ${name.padEnd(15)} -> ${hook.file} (${hook.description})`);
  }
  console.log(
    `  ${'copilot'.padEnd(15)} -> $COPILOT_HOME or ~/.copilot, and each VS Code User folder ` +
      '(GitHub Copilot: hooks, MCP server and instructions)',
  );
  console.log('\nUsage: hippo hook install <name>');
  console.log('       hippo hook uninstall <name>');
}

function hookInstall(target: string | undefined): void {
  // Copilot's instructions live in its home folder, not in a project file, so it has no HOOKS
  // entry.
  if (target === 'copilot') return printCopilotInstall(installCopilot(), '');
  if (!target || !HOOKS[target]) {
    printError(`Unknown hook target: ${target ?? '(none)'}`);
    fail(`   Available: ${[...Object.keys(HOOKS), 'copilot'].join(', ')}`);
  }
  const hook = HOOKS[target];
  patchAgentFile(hook, target);

  // For Claude Code, also install SessionEnd+SessionStart entries in its settings file.
  if (target === 'claude-code') {
    printClaudeHookInstall(installJsonHooks(target));
  } else if (target === 'opencode') {
    installOpencodeHook();
  } else if (target === 'codex') {
    installCodexMemoryHooks('');
    // The wrapper stays the capture path; the hooks above work without it, so a missing launcher is
    // not an error.
    if (detectRealCodexPath()) {
      const result = installCodexWrapper();
      console.log(`Installed Codex session-end integration -> ${result.metadataPath}`);
      console.log(`   Wrapped detected Codex launcher at ${result.commandPath}`);
    } else {
      console.log(
        'No codex launcher on PATH, so session-end capture was not set up; re-run once `codex` is on PATH.',
      );
    }
  }
}

function patchAgentFile(hook: HookSpec, target: string): void {
  const filepath = path.resolve(process.cwd(), hook.file);

  const block = hookBlock(hook);

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
      writeFileAtomic(filepath, updated);
      console.log(`Updated Hippo hook in ${hook.file}`);
    } else {
      appendHookBlock(filepath, existing, hook);
      console.log(`Installed Hippo hook in ${hook.file} (appended)`);
    }
  } else {
    // Do not create an agent-instructions file (CLAUDE.md, AGENTS.md, etc.) in directories without
    // one, to avoid polluting cwd; the settings.json hook below is still installed for claude-code.
    console.log(`${hook.file} not found in ${process.cwd()} — skipping agent-instructions patch.`);
    console.log(
      `   Create ${hook.file} and re-run \`hippo hook install ${target}\` if you want the agent prompt.`,
    );
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
    console.log(
      `Installed hippo compact-resume SessionStart(compact) hook in ${result.target} settings`,
    );
  }
  if (result.installedPostCompact) {
    console.log(`Installed hippo post-compact PostCompact hook in ${result.target} settings`);
  }
  if (result.installedCaptureError) {
    console.log(
      `Installed hippo capture-error PostToolUseFailure hook in ${result.target} settings`,
    );
  }
  if (result.migratedFromStop) {
    console.log(
      `Migrated legacy Stop hook → SessionEnd (was running every turn; now fires once on session exit)`,
    );
  }
  if (result.migratedSplitSessionEnd) {
    console.log(
      `Migrated split sleep+capture SessionEnd entries → single detached hippo session-end`,
    );
  } else if (result.migratedLegacySessionEnd) {
    console.log(`Migrated legacy SessionEnd entry to the new detached form`);
  }
}

function installOpencodeHook(): void {
  // opencode uses a TS plugin, not JSON hooks. See src/surface/hooks-install/rules/opencode.ts.
  const result = installOpencodePlugin();
  if (result.installed) {
    console.log(`Installed hippo opencode plugin at ${result.pluginPath}`);
  } else {
    console.log(`opencode plugin already up to date at ${result.pluginPath}`);
  }
  if (result.migratedLegacyHooks) {
    console.log(
      `Removed legacy Claude Code-style hooks block from opencode.json — opencode can now launch`,
    );
  }
  if (result.jsonRepairFailed) {
    console.log(
      `WARNING: opencode.json is unparseable; legacy hooks block could not be auto-removed. ` +
        `Fix the file manually.`,
    );
  }
}

function hookUninstall(target: string | undefined): void {
  if (target === 'copilot') return printCopilotUninstall(uninstallCopilot());
  if (!target || !HOOKS[target]) {
    fail(`Unknown hook target: ${target ?? '(none)'}`);
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
    // opencode uses a TS plugin; uninstall removes the plugin file and also runs the legacy-hooks
    // migration, so remove leaves opencode launchable.
    if (uninstallOpencodePlugin()) {
      console.log(`Removed hippo opencode plugin (and any legacy hooks block from opencode.json)`);
    }
  } else if (target === 'codex') {
    if (uninstallJsonHooks('codex')) {
      console.log(
        `Removed hippo's Codex memory hooks from ${resolveJsonHookPaths('codex').settings}`,
      );
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
    const whose = owner
      ? `hippo wrote it for ${owner}`
      : 'it has been edited, so hippo cannot tell whose it is';
    console.log(
      `Left the hippo block in ${hook.file}: ${whose}. Delete it by hand if no agent needs it.`,
    );
  } else if (existing.includes(HOOK_MARKERS.start)) {
    writeFileAtomic(filepath, withoutHookBlock(existing) + '\n');
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
    if (left) writeFileAtomic(legacy, left + '\n');
    else fs.unlinkSync(legacy);
    console.log(
      left
        ? 'Removed the old Hippo hook from .cursorrules'
        : 'Deleted .cursorrules, which held only the old Hippo hook',
    );
  }
}
