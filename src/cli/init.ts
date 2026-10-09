// `hippo init`: create a store and wire the detected agents' instruction files, hooks and daily runner.

import { envSkipAutoIntegrations } from '../util/env.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { installJsonHooks } from '../hooks/json-hooks.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import { isCodexPresent } from '../hooks/shared.js';
import { isCodexWrapperInstalled } from '../hooks/codex-wrapper.js';
import { installOpencodePlugin } from '../hooks/opencode.js';
import { isInitialized, initStore } from '../store/open.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { isGitRepo } from '../learn/autolearn.js';
import { currentMachine, importForStore, importProjectMemories, importUserMemories } from '../agent-memories/sync.js';
import { emptyReport, mergeReports } from '../agent-memories/report.js';
import { getGlobalRoot, initGlobal } from '../sharing/global-store.js';
import { registerWorkspace } from './scheduler.js';
import { type CliFlags, printAgentImport, installCodexMemoryHooks, setupDailySchedule, learnFromRepo, skipLearnOnSharedStore, warnClaudeSettingsUnusable, stringFlag } from './shared.js';
import { HOOK_MARKERS, HOOKS, hippoBlock } from '../hooks/hook-blocks.js';

function scanForGitRepos(rootDir: string, maxDepth = 2): string[] {
  const repos: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (fs.existsSync(path.join(full, '.git'))) {
          repos.push(full);
        }
        if (depth < maxDepth) walk(full, depth + 1);
      }
    } catch { /* permission denied, etc */ }
  }
  // Check if rootDir itself is a git repo
  if (fs.existsSync(path.join(rootDir, '.git'))) repos.push(rootDir);
  walk(rootDir, 0);
  return repos;
}

/** Creates the repo's store when absent and registers it; returns whether it already existed. */
function initScannedRepo(repo: string, globalRoot: string): boolean {
  const repoHippo = path.join(repo, '.hippo');
  const alreadyExists = isInitialized(repoHippo);
  if (!alreadyExists) {
    initStore(repoHippo);
  }
  registerWorkspace(globalRoot, repo);
  return alreadyExists;
}

/** Seeds one scanned repo from git history and its agents' notes, unless --no-learn. */
function learnScannedRepo(
  repo: string,
  seedDays: number,
  learn: boolean,
  machine: ReturnType<typeof currentMachine>,
  agentImport: ReturnType<typeof emptyReport>,
): Pick<ReturnType<typeof learnFromRepo>, 'added' | 'lowInfo'> {
  const repoHippo = path.join(repo, '.hippo');
  let added = 0;
  let lowInfo = 0;
  if (learn && isGitRepo(repo)) {
    const result = learnFromRepo(repoHippo, repo, seedDays, path.basename(repo));
    added = result.added;
    lowInfo = result.lowInfo;
  }
  if (learn) mergeReports(agentImport, importProjectMemories(repoHippo, { machine }));
  return { added, lowInfo };
}

function installScanHooks(repos: readonly string[]): void {
  // User-level hooks only: a hippo block in each repo's CLAUDE.md or AGENTS.md would leave a diff in every repo.
  const agents = detectAgentHooks(repos);
  if (agents.length === 0) {
    console.log('   No agent config found in these repositories. Run `hippo setup` to add hooks for the agents on this machine.');
  }
  installUserLevelHooks(agents, true);
}

function initGlobalFirst(): string {
  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    initGlobal();
    console.log(`Initialized global store at ${globalRoot}\n`);
  }
  return globalRoot;
}

function printScanSummary(repoCount: number, totalLessons: number, totalLowInfo: number): void {
  console.log(`\n${repoCount} repositories, ${totalLessons} new lessons learned` +
    (totalLowInfo > 0 ? `, ${totalLowInfo} low-information subject(s) dropped` : '') +
    '.');
}

function cmdInitScan(scanDir: string, flags: CliFlags): void {
  const resolved = path.resolve(scanDir);
  console.log(`Scanning ${resolved} for git repositories...\n`);

  const repos = scanForGitRepos(resolved);
  if (repos.length === 0) {
    console.log('No git repositories found.');
    return;
  }

  console.log(`Found ${repos.length} repositories:\n`);

  const globalRoot = initGlobalFirst();

  let totalLessons = 0;
  // Rolled up so the cross-repo summary reports the gate too. Each repo
  // already prints its own count inside learnFromRepo, but the aggregate
  // line showed only what was ADDED - and the point of this change is
  // that a dropped subject is never invisible.
  let totalLowInfo = 0;
  const seedDays = parseInt(String(flags['days'] ?? '365'), 10);
  const machine = currentMachine();
  const agentImport = emptyReport();
  const learn = !flags['no-learn'];

  for (const repo of repos) {
    const alreadyExists = initScannedRepo(repo, globalRoot);
    const { added, lowInfo } = learnScannedRepo(repo, seedDays, learn, machine, agentImport);
    totalLessons += added;
    totalLowInfo += lowInfo;

    const status = alreadyExists ? 'existing' : 'new';
    const entries = loadAllEntries(path.join(repo, '.hippo'));
    console.log(`  ${path.basename(repo).padEnd(25)} ${status.padEnd(10)} ${entries.length} memories${added > 0 ? ` (+${added} from git)` : ''}`);
  }

  printScanSummary(repos.length, totalLessons, totalLowInfo);
  if (learn) {
    mergeReports(agentImport, importUserMemories(globalRoot, { machine }));
    printAgentImport(agentImport, '');
  }
  console.log(`Global store: ${globalRoot}`);
  if (initInstallsIntegrations(flags)) installScanHooks(repos);
  if (!flags['no-schedule']) {
    setupDailySchedule(globalRoot);
  }
  console.log(`\nRun \`hippo sleep\` in any project to consolidate and auto-share to global.`);
}

function initGlobalOnly(flags: CliFlags): void {
  const globalRoot = getGlobalRoot();
  if (isInitialized(globalRoot)) {
    console.log('Already initialized global store at', globalRoot);
  } else {
    initGlobal();
    console.log('Initialized global Hippo store at', globalRoot);
  }
  if (!flags['no-learn']) printAgentImport(importUserMemories(globalRoot, { machine: currentMachine() }));
}

function seedFromGitHistory(hippoRoot: string): void {
  if (!isGitRepo(process.cwd())) return;
  const seedDays = 30;
  console.log(`\n   Seeding memories from last ${seedDays} days of git history...`);
  const { added, skipped } = learnFromRepo(hippoRoot, process.cwd(), seedDays);
  if (added > 0) {
    console.log(`   Learned ${added} lessons from git (${skipped} duplicates skipped).`);
  } else {
    console.log(`   No matching commits found in git history.`);
  }
}

export function cmdInit(hippoRoot: string, flags: CliFlags): void {
  // Handle --scan mode
  if (flags['scan']) {
    const scanDir = stringFlag(flags, 'scan') ?? os.homedir();
    cmdInitScan(scanDir, flags);
    return;
  }

  if (flags['global']) {
    initGlobalOnly(flags);
    return;
  }

  const alreadyExists = isInitialized(hippoRoot);
  if (alreadyExists) {
    console.log('Already initialized at', hippoRoot);
  } else {
    initStore(hippoRoot);
    console.log('Initialized Hippo at', hippoRoot);
    console.log('   Directories: buffer/ episodic/ semantic/ conflicts/');
    console.log('   Files: hippo.db stats.json');
  }

  const globalRoot = getGlobalRoot();
  registerWorkspace(globalRoot, path.dirname(hippoRoot));

  if (initInstallsIntegrations(flags)) {
    autoInstallHooks();
  }

  // Auto-setup daily schedule (unless --no-schedule)
  if (!flags['no-schedule'] && !flags['global']) {
    setupDailySchedule(globalRoot);
  }

  const learn = !flags['no-learn'] && !skipLearnOnSharedStore(hippoRoot);
  // Seed with git history on first init (unless --no-learn)
  if (!alreadyExists && learn && !flags['global']) seedFromGitHistory(hippoRoot);

  // Every run, not only the first: an agent's notes change between inits.
  if (learn) printAgentImport(importForStore(hippoRoot, { machine: currentMachine() }));
}

/** Every write init makes into agent config (instruction blocks, hooks, plugins) is an automatic integration, so one switch skips them all. */
function initInstallsIntegrations(flags: CliFlags): boolean {
  if (flags['no-hooks']) return false;
  if (!envSkipAutoIntegrations()) return true;
  console.log('   HIPPO_SKIP_AUTO_INTEGRATIONS=1, so init left agent instruction files and hooks alone.');
  return false;
}

/** Plain init: patch the detected agents' instruction files in cwd, then install their user-level hooks. */
function autoInstallHooks(): void {
  const cwd = process.cwd();
  const agents = detectAgentHooks([cwd]);
  const agentsMd = path.join(cwd, HOOKS.codex.file);
  // Read before patching: a re-run of init finds its own block and skips the Codex hint.
  const codexHint = !(fs.existsSync(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes(HOOK_MARKERS.start));
  patchInstructionFiles(cwd, agents);
  installUserLevelHooks(agents, codexHint);
}

/** HOOKS keys of the agents with a marker file in any of dirs, in detector order. */
function detectAgentHooks(dirs: readonly string[]): string[] {
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
    // Never create the file: a marker such as .codex or .claude/settings.json does not ask for a new AGENTS.md or CLAUDE.md.
    if (!fs.existsSync(targetPath) || seen.has(targetPath)) continue;
    seen.add(targetPath);
    const existing = fs.readFileSync(targetPath, 'utf8');
    if (existing.includes(HOOK_MARKERS.start)) {
      refreshShippedBlock(targetPath, existing, hook);
      continue;
    }
    const block = `${HOOK_MARKERS.start}\n${hookDef.content}\n${HOOK_MARKERS.end}`;
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    writeFileAtomic(targetPath, existing + sep + block + '\n');
    console.log(`   Auto-installed ${hook} hook in ${hookDef.file}`);
  }
}

/** Swap an unedited block from an earlier hippo for the current one; an edited block stays, with a hint. */
function refreshShippedBlock(filePath: string, text: string, hook: string): void {
  const block = hippoBlock(text);
  if (!block || (block.owner && HOOKS[block.owner].content === block.inner)) return;
  const { start, end, eol, owner } = block;
  const name = path.basename(filePath);
  if (!owner) {
    console.log(`   Left the edited hippo block in ${name} as is; \`hippo hook install ${hook}\` replaces it.`);
    return;
  }
  writeFileAtomic(filePath, `${text.slice(0, start)}${eol}${HOOKS[owner].content.replace(/\n/g, eol)}${eol}${text.slice(end)}`);
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
    console.log(`   Auto-installed hippo compact-resume SessionStart(compact) hook in ${hook} settings`);
  }
  if (result.installedPostCompact) {
    console.log(`   Auto-installed hippo post-compact PostCompact hook in ${hook} settings`);
  }
  if (result.installedCaptureError) {
    console.log(`   Auto-installed hippo capture-error PostToolUseFailure hook in ${hook} settings`);
  }
  if (result.migratedFromStop) {
    console.log(`   Migrated legacy Stop hook → SessionEnd (no longer runs every turn)`);
  }
  if (result.migratedSplitSessionEnd) {
    console.log(`   Migrated split sleep+capture SessionEnd entries → single detached hippo session-end`);
  } else if (result.migratedLegacySessionEnd) {
    console.log(`   Migrated legacy SessionEnd entry to the new detached form`);
  }
}

function installOpencodeUserPlugin(): void {
  // opencode uses a TS plugin, not Claude Code's JSON-hook schema.
  // See OPENCODE_PLUGIN_SOURCE in src/hooks.ts for the plugin file
  // content + design rationale.
  const result = installOpencodePlugin();
  if (result.installed) {
    console.log(`   Auto-installed hippo opencode plugin -> ${result.pluginPath}`);
  }
  if (result.migratedLegacyHooks) {
    console.log(`   Removed legacy Claude Code-style hooks block from opencode.json — opencode can now launch`);
  }
  if (result.jsonRepairFailed) {
    console.log(`   WARNING: opencode.json is unparseable; legacy hooks block could not be auto-removed. Fix the file manually.`);
  }
}

/** Claude Code settings hooks, Codex's hooks.json and the OpenCode plugin, under the home directory; idempotent, so re-running init adds newer hooks. */
function installUserLevelHooks(agents: readonly string[], codexHint: boolean): void {
  for (const hook of agents) {
    // The Codex capture wrapper swaps the codex launcher binary, so init only points at the opt-in.
    if (hook === 'codex' && codexHint && !isCodexWrapperInstalled()) {
      console.log('   Codex detected. To capture Codex sessions: hippo hook install codex');
    }
    // Checked first so init never creates ~/.codex on a machine without Codex.
    if (hook === 'codex' && isCodexPresent()) installCodexMemoryHooks('   ');

    // For Claude Code, also install SessionEnd+SessionStart entries in its
    // settings.json. Keeps `hippo init` in lockstep with `hippo hook install
    // claude-code` and `hippo setup`.
    if (hook === 'claude-code') installClaudeCodeSettingsHooks(hook);
    else if (hook === 'opencode') installOpencodeUserPlugin();
  }
}
