// `hippo init`: create a store and wire the detected agents' instruction files, hooks and daily
// runner.

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { initMemoryStore } from '../../api/store-init.js';
import { isInitialized } from '../../host/project-identity.js';
import { hippoHomeDir } from '../../host/agent-homes.js';
import { memoryList } from '../../api/memories/memories.js';
import { cliInitGlobal, type CliCommand } from './api-context.js';
import { isGitRepo } from '../../base/ports/git.js';
import { processGit } from '../../infra/git-runner.js';
import {
  importForStore,
  importProjectMemories,
  importUserMemories,
} from '../../api/agent-memories.js';
import { currentMachine } from '../../infra/machine.js';
import { emptyReport, mergeReports } from '../../base/memory/agent-memory-report.js';
import { registerWorkspace } from './scheduler.js';
import {
  type CliFlags,
  numberFlag,
  stringFlag,
  type CommandContext,
  boolFlag,
} from './flag-values.js';
import { printAgentImport } from './print.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';
import { setupDailySchedule } from './install-steps.js';
import {
  autoInstallHooks,
  detectAgentHooks,
  initInstallsIntegrations,
  installUserLevelHooks,
} from './init-integrations.js';
import { learnFromRepo, skipLearnOnSharedStore } from './shared.js';
import { HIPPO_DIR } from '../../base/util/agent-homes.js';
import { SEED_DAYS_SCAN, SEED_DAYS_SINGLE } from './flag-defaults.js';

// An unreadable or vanished folder is expected while scanning; any other failure is worth a line.
const QUIET_SCAN_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']);

function scanForGitRepos(rootDir: string, maxDepth = 2): string[] {
  const repos: string[] = [];
  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (fs.existsSync(path.join(full, '.git'))) {
          repos.push(full);
        }
        if (depth < maxDepth) walk(full, depth + 1);
      }
    } catch (err) {
      const code = errorCode(err);
      if (!QUIET_SCAN_ERRORS.has(code)) {
        log.warn(`repo scan skipped ${dir}`, {
          code: code || 'unknown',
          reason: errorMessage(err),
          ...errorFields(err),
        });
      }
    }
  }
  if (fs.existsSync(path.join(rootDir, '.git'))) repos.push(rootDir);
  walk(rootDir, 0);
  return repos;
}

interface InitScannedRepoOptions {
  readonly cli: CliCommand;
  readonly repo: string;
  readonly tenantId: string;
  readonly globalRoot: string;
}

/** Creates the repo's store when absent and registers it; returns whether it already existed. */
async function initScannedRepo({
  cli,
  repo,
  tenantId,
  globalRoot,
}: InitScannedRepoOptions): Promise<boolean> {
  const repoHippo = path.join(repo, HIPPO_DIR);
  const alreadyExists = isInitialized(repoHippo);
  if (!alreadyExists) {
    await initMemoryStore(cli.apiContext(repoHippo, tenantId));
  }
  registerWorkspace(globalRoot, repo);
  return alreadyExists;
}

interface LearnScannedRepoOptions {
  cli: CliCommand;
  repo: string;
  tenantId: string;
  seedDays: number;
  learn: boolean;
  machine: ReturnType<typeof currentMachine>;
  agentImport: ReturnType<typeof emptyReport>;
}

/** Seeds one scanned repo from git history and its agents' notes, unless --no-learn. */
async function learnScannedRepo(
  options: LearnScannedRepoOptions,
): Promise<Pick<Awaited<ReturnType<typeof learnFromRepo>>, 'added' | 'lowInfo'>> {
  const { cli, repo, tenantId, seedDays, learn, machine, agentImport } = options;
  const repoHippo = path.join(repo, HIPPO_DIR);
  let added = 0;
  let lowInfo = 0;
  if (learn && isGitRepo(machine.git, repo)) {
    const result = await learnFromRepo({
      ctx: cli.apiContext(repoHippo, tenantId),
      repoPath: repo,
      days: seedDays,
      label: path.basename(repo),
    });
    added = result.added;
    lowInfo = result.lowInfo;
  }
  if (learn) {
    mergeReports(
      agentImport,
      await importProjectMemories(repoHippo, cli.syncOptions(tenantId, machine)),
    );
  }
  return { added, lowInfo };
}

function installScanHooks(repos: readonly string[]): void {
  // User-level hooks only: a hippo block in each repo's CLAUDE.md or AGENTS.md would leave a diff
  // in every repo.
  const agents = detectAgentHooks(repos);
  if (agents.length === 0) {
    console.log(
      '   No agent config found in these repositories. Run `hippo setup` to add hooks for the agents on this machine.',
    );
  }
  installUserLevelHooks(agents, true);
}

function initGlobalFirst(): string {
  const globalRoot = hippoHomeDir();
  if (!isInitialized(globalRoot)) {
    cliInitGlobal();
    console.log(`Initialized global store at ${globalRoot}\n`);
  }
  return globalRoot;
}

interface ScanSummary {
  readonly repoCount: number;
  readonly totalLessons: number;
  readonly totalLowInfo: number;
}

function printScanSummary({ repoCount, totalLessons, totalLowInfo }: ScanSummary): void {
  console.log(
    `\n${repoCount} repositories, ${totalLessons} new lessons learned` +
      (totalLowInfo > 0 ? `, ${totalLowInfo} low-information subject(s) dropped` : '') +
      '.',
  );
}

interface RepoScan extends Omit<LearnScannedRepoOptions, 'repo'> {
  readonly globalRoot: string;
}

/** Inits, seeds and lists each repo in turn; the totals feed the cross-repo summary. */
async function initEachScannedRepo(
  repos: readonly string[],
  scan: RepoScan,
): Promise<Omit<ScanSummary, 'repoCount'>> {
  const { cli, tenantId, globalRoot, seedDays, learn, machine, agentImport } = scan;
  let totalLessons = 0;
  // Rolled up so the cross-repo summary reports the gate too: a dropped subject is never invisible.
  let totalLowInfo = 0;
  for (const repo of repos) {
    const alreadyExists = await initScannedRepo({ cli, repo, tenantId, globalRoot });
    const { added, lowInfo } = await learnScannedRepo({
      cli,
      repo,
      tenantId,
      seedDays,
      learn,
      machine,
      agentImport,
    });
    totalLessons += added;
    totalLowInfo += lowInfo;

    const status = alreadyExists ? 'existing' : 'new';
    const entries = await memoryList(cli.apiContext(path.join(repo, HIPPO_DIR), tenantId), {
      everyTenant: true,
    });
    console.log(
      `  ${path.basename(repo).padEnd(25)} ${status.padEnd(10)} ${entries.length} ` +
        `memories${added > 0 ? ` (+${added} from git)` : ''}`,
    );
  }
  return { totalLessons, totalLowInfo };
}

async function initScannedRepos(
  cli: CliCommand,
  scanDir: string,
  tenantId: string,
  flags: CliFlags,
): Promise<void> {
  const resolved = path.resolve(scanDir);
  console.log(`Scanning ${resolved} for git repositories...\n`);

  const repos = scanForGitRepos(resolved);
  if (repos.length === 0) {
    console.log('No git repositories found.');
    return;
  }

  console.log(`Found ${repos.length} repositories:\n`);

  const globalRoot = initGlobalFirst();
  const seedDays = numberFlag(flags, 'days') ?? SEED_DAYS_SCAN;
  const machine = currentMachine();
  const agentImport = emptyReport();
  const learn = !boolFlag(flags, 'no-learn');
  const scan: RepoScan = { cli, tenantId, globalRoot, seedDays, learn, machine, agentImport };
  const totals = await initEachScannedRepo(repos, scan);

  printScanSummary({ repoCount: repos.length, ...totals });
  if (learn) {
    mergeReports(
      agentImport,
      await importUserMemories(globalRoot, cli.syncOptions(tenantId, machine)),
    );
    printAgentImport(agentImport, '');
  }
  console.log(`Global store: ${globalRoot}`);
  if (initInstallsIntegrations(flags)) installScanHooks(repos);
  if (!boolFlag(flags, 'no-schedule')) {
    setupDailySchedule(globalRoot);
  }
  console.log(`\nRun \`hippo sleep\` in any project to consolidate and auto-share to global.`);
}

async function initGlobalOnly(cli: CliCommand, tenantId: string, flags: CliFlags): Promise<void> {
  const globalRoot = hippoHomeDir();
  if (isInitialized(globalRoot)) {
    console.log('Already initialized global store at', globalRoot);
  } else {
    cliInitGlobal();
    console.log('Initialized global Hippo store at', globalRoot);
  }
  if (!boolFlag(flags, 'no-learn')) {
    printAgentImport(
      await importUserMemories(globalRoot, cli.syncOptions(tenantId, currentMachine())),
    );
  }
}

async function seedFromGitHistory(
  cli: CliCommand,
  hippoRoot: string,
  tenantId: string,
): Promise<void> {
  if (!isGitRepo(processGit, process.cwd())) return;
  const seedDays = SEED_DAYS_SINGLE;
  console.log(`\n   Seeding memories from last ${seedDays} days of git history...`);
  const { added, skipped } = await learnFromRepo({
    ctx: cli.apiContext(hippoRoot, tenantId),
    repoPath: process.cwd(),
    days: seedDays,
  });
  if (added > 0) {
    console.log(`   Learned ${added} lessons from git (${skipped} duplicates skipped).`);
  } else {
    console.log(`   No matching commits found in git history.`);
  }
}

export async function handleInit({
  hippoRoot,
  tenantId,
  flags,
  cli,
}: CommandContext): Promise<void> {
  if (boolFlag(flags, 'scan')) {
    const scanDir = stringFlag(flags, 'scan') ?? os.homedir();
    await initScannedRepos(cli, scanDir, tenantId, flags);
    return;
  }

  if (boolFlag(flags, 'global')) {
    await initGlobalOnly(cli, tenantId, flags);
    return;
  }

  const alreadyExists = isInitialized(hippoRoot);
  if (alreadyExists) {
    console.log('Already initialized at', hippoRoot);
  } else {
    await initMemoryStore(cli.apiContext(hippoRoot, tenantId));
    console.log('Initialized Hippo at', hippoRoot);
    console.log('   Directories: buffer/ episodic/ semantic/ conflicts/');
    console.log('   Files: hippo.db stats.json');
  }

  const globalRoot = hippoHomeDir();
  registerWorkspace(globalRoot, path.dirname(hippoRoot));

  if (initInstallsIntegrations(flags)) {
    autoInstallHooks();
  }

  // Auto-setup daily schedule (unless --no-schedule)
  if (!boolFlag(flags, 'no-schedule') && !boolFlag(flags, 'global')) {
    setupDailySchedule(globalRoot);
  }

  const learn = !boolFlag(flags, 'no-learn') && !skipLearnOnSharedStore(hippoRoot);
  // Seed with git history on first init (unless --no-learn)
  if (!alreadyExists && learn && !boolFlag(flags, 'global')) {
    await seedFromGitHistory(cli, hippoRoot, tenantId);
  }

  // Every run, not only the first: an agent's notes change between inits.
  if (learn) {
    printAgentImport(await importForStore(hippoRoot, cli.syncOptions(tenantId, currentMachine())));
  }
}
