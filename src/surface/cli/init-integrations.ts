// The agent integrations `hippo init` writes: instruction-file blocks, user-level hooks and the
// OpenCode plugin.

import { envSkipAutoIntegrations } from '../../base/util/env.js';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { installJsonHooks } from '../hooks-install/json-hooks.js';
import { writeFileAtomic } from '../../host/atomic-write.js';
import { isCodexPresent } from '../hooks-install/detect.js';
import { isCodexWrapperInstalled } from '../hooks-install/codex-wrapper.js';
import { installOpencodePlugin } from '../hooks-install/opencode.js';
import { type CliFlags, boolFlag } from './flag-values.js';
import { installCodexMemoryHooks, warnClaudeSettingsUnusable } from './install-steps.js';
import { appendHookBlock, HOOK_MARKERS, HOOKS, hippoBlock } from '../hooks-install/instructions.js';

/**
 * Every write init makes into agent config (instruction blocks, hooks, plugins) is an automatic
 * integration, so one switch skips them all.
 */
export function initInstallsIntegrations(flags: CliFlags): boolean {
  if (boolFlag(flags, 'no-hooks')) return false;
  if (!envSkipAutoIntegrations()) return true;
  console.log(
    '   HIPPO_SKIP_AUTO_INTEGRATIONS=1, so init left agent instruction files and hooks alone.',
  );
  return false;
}

/** Plain init: patch the detected agents' instruction files in cwd, then install their
 * user-level hooks. */
export function autoInstallHooks(): void {
  const cwd = process.cwd();
  const agents = detectAgentHooks([cwd]);
  const agentsMd = path.join(cwd, HOOKS.codex.file);
  // Read before patching: a re-run of init finds its own block and skips the Codex hint.
  const codexHint = !(
    fs.existsSync(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes(HOOK_MARKERS.start)
  );
  patchInstructionFiles(cwd, agents);
  installUserLevelHooks(agents, codexHint);
}

/** HOOKS keys of the agents with a marker file in any of dirs, in detector order. */
export function detectAgentHooks(dirs: readonly string[]): string[] {
  // Map: filename to check -> hook key(s) to install
  const detectors: Array<{ files: string[]; hook: string }> = [
    { files: ['CLAUDE.md', '.claude/settings.json'], hook: 'claude-code' },
    { files: ['AGENTS.md', '.codex'], hook: 'codex' },
    // No Cursor row: Cursor reads the root AGENTS.md, which the rows either side patch.
    { files: ['.openclaw', 'AGENTS.md'], hook: 'openclaw' },
    { files: ['.opencode', 'opencode.json'], hook: 'opencode' },
    { files: ['.pi', '.pi/agent'], hook: 'pi' },
  ];

  return detectors
    .filter(({ files }) => dirs.some((dir) => files.some((f) => fs.existsSync(path.join(dir, f)))))
    .map(({ hook }) => hook);
}

function patchInstructionFiles(dir: string, agents: readonly string[]): void {
  // One block per file: several agents share AGENTS.md.
  const seen = new Set<string>();
  for (const hook of agents) {
    const hookDef = HOOKS[hook];
    if (!hookDef) continue;

    const targetPath = path.resolve(dir, hookDef.file);
    // Never create the file: a marker such as .codex or .claude/settings.json does not ask for a
    // new AGENTS.md or CLAUDE.md.
    if (!fs.existsSync(targetPath) || seen.has(targetPath)) continue;
    seen.add(targetPath);
    const existing = fs.readFileSync(targetPath, 'utf8');
    if (existing.includes(HOOK_MARKERS.start)) {
      refreshShippedBlock({ filePath: targetPath, text: existing, hook });
      continue;
    }
    appendHookBlock(targetPath, existing, hookDef);
    console.log(`   Auto-installed ${hook} hook in ${hookDef.file}`);
  }
}

interface ShippedBlockOptions {
  readonly filePath: string;
  readonly text: string;
  readonly hook: string;
}

/** Swap an unedited block from an earlier hippo for the current one; an edited block stays, with
 * a hint. */
function refreshShippedBlock({ filePath, text, hook }: ShippedBlockOptions): void {
  const block = hippoBlock(text);
  if (!block || (block.owner && HOOKS[block.owner].content === block.inner)) return;
  const { start, end, eol, owner } = block;
  const name = path.basename(filePath);
  if (!owner) {
    console.log(
      `   Left the edited hippo block in ${name} as is; \`hippo hook install ${hook}\` replaces it.`,
    );
    return;
  }
  writeFileAtomic(
    filePath,
    `${text.slice(0, start)}${eol}${HOOKS[owner].content.replace(/\n/g, eol)}${eol}${text.slice(end)}`,
  );
  console.log(`   Refreshed the ${owner} hippo block in ${name}`);
}

function installClaudeCodeSettingsHooks(hook: 'claude-code'): void {
  const result = installJsonHooks(hook);
  warnClaudeSettingsUnusable(result, '   ');
  if (result.installedSessionEnd) {
    console.log(`   Auto-installed hippo session-end SessionEnd hook in ${hook} settings`);
  }
  if (result.installedSessionStart) {
    console.log(`   Auto-installed hippo last-sleep SessionStart hook in ${hook} settings`);
  }
  if (result.installedUserPromptSubmit) {
    console.log(`   Auto-installed hippo pinned-inject UserPromptSubmit hook in ${hook} settings`);
  }
  if (result.installedPreCompact) {
    console.log(`   Auto-installed hippo pre-compact PreCompact hook in ${hook} settings`);
  }
  if (result.installedCompactResume) {
    console.log(
      `   Auto-installed hippo compact-resume SessionStart(compact) hook in ${hook} settings`,
    );
  }
  if (result.installedPostCompact) {
    console.log(`   Auto-installed hippo post-compact PostCompact hook in ${hook} settings`);
  }
  if (result.installedCaptureError) {
    console.log(
      `   Auto-installed hippo capture-error PostToolUseFailure hook in ${hook} settings`,
    );
  }
  if (result.migratedFromStop) {
    console.log(`   Migrated legacy Stop hook → SessionEnd (no longer runs every turn)`);
  }
  if (result.migratedSplitSessionEnd) {
    console.log(
      `   Migrated split sleep+capture SessionEnd entries → single detached hippo session-end`,
    );
  } else if (result.migratedLegacySessionEnd) {
    console.log(`   Migrated legacy SessionEnd entry to the new detached form`);
  }
}

function installOpencodeUserPlugin(): void {
  // opencode uses a TS plugin, not Claude Code's JSON-hook schema (see OPENCODE_PLUGIN_SOURCE in
  // src/surface/hooks-install/rules/opencode.ts).
  const result = installOpencodePlugin();
  if (result.installed) {
    console.log(`   Auto-installed hippo opencode plugin -> ${result.pluginPath}`);
  }
  if (result.migratedLegacyHooks) {
    console.log(
      `   Removed legacy Claude Code-style hooks block from opencode.json — opencode can now launch`,
    );
  }
  if (result.jsonRepairFailed) {
    console.log(
      `   WARNING: opencode.json is unparseable; legacy hooks block could not be auto-removed. Fix the file manually.`,
    );
  }
}

/**
 * Claude Code settings hooks, Codex's hooks.json and the OpenCode plugin, under the home directory;
 * idempotent, so re-running init adds newer hooks.
 */
export function installUserLevelHooks(agents: readonly string[], codexHint: boolean): void {
  for (const hook of agents) {
    // The Codex capture wrapper swaps the codex launcher binary, so init only points at the opt-in.
    if (hook === 'codex' && codexHint && !isCodexWrapperInstalled()) {
      console.log('   Codex detected. To capture Codex sessions: hippo hook install codex');
    }
    // Checked first so init never creates ~/.codex on a machine without Codex.
    if (hook === 'codex' && isCodexPresent()) installCodexMemoryHooks('   ');

    // For Claude Code, also install SessionEnd+SessionStart entries in settings.json, keeping
    // `hippo init` in lockstep with `hippo hook install claude-code` and `hippo setup`.
    if (hook === 'claude-code') installClaudeCodeSettingsHooks(hook);
    else if (hook === 'opencode') installOpencodeUserPlugin();
  }
}
