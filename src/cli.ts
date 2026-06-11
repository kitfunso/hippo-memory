#!/usr/bin/env node
/**
 * Hippo CLI  - biologically-inspired memory system for AI agents.
 *
 * Commands:
 *   hippo init [--global]
 *   hippo remember <text> [--tag <t>] [--error] [--pin] [--global]
 *   hippo recall <query> [--budget <n>] [--json] [--why]
 *   hippo sleep [--dry-run]
 *   hippo status
 *   hippo outcome --good | --bad [--id <id>]
 *   hippo conflicts [--status <status>] [--json]
 *   hippo snapshot <save|show|clear>
 *   hippo session <log|show|latest|resume|complete>
 *   hippo handoff <create|latest|show>
 *   hippo current <show>
 *   hippo forget <id> [--archive --reason "<why>"]
 *   hippo inspect <id>
 *   hippo embed [--status]
 *   hippo watch "<command>"
 *   hippo learn --git [--days <n>] [--repos <paths>]
 *   hippo daily-runner
 *   hippo promote <id>
 *   hippo sync
 *   hippo decide "<decision>" [--context "<why>"] [--supersedes <id>]
 *   hippo wm <push|read|clear|flush>
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawn } from 'child_process';
import {
  installJsonHooks,
  uninstallJsonHooks,
  resolveJsonHookPaths,
  detectInstalledTools,
  defaultSleepLogPath,
  ensureCodexWrapperInstalled,
  installCodexWrapper,
  uninstallCodexWrapper,
  resolveCodexSessionTranscript,
  resolveCodexWrapperPaths,
  installOpencodePlugin,
  uninstallOpencodePlugin,
  resolveOpencodePluginPath,
  type CodexWrapperMetadata,
  type JsonHookTarget,
} from './hooks.js';
import {
  createMemory,
  calculateStrength,
  calculateRewardFactor,
  deriveHalfLife,
  resolveConfidence,
  applyOutcome,
  computeSchemaFit,
  Layer,
  MemoryEntry,
  ConfidenceLevel,
} from './memory.js';
import {
  getHippoRoot,
  isInitialized,
  initStore,
  writeEntry,
  readEntry,
  deleteEntry,
  loadAllEntries,
  loadSearchEntries,
  loadIndex,
  saveIndex,
  loadStats,
  updateStats,
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
  listMemoryConflicts,
  resolveConflict,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  TaskSnapshot,
  SessionEvent,
  RECALL_DEFAULT_DENY_SCOPES,
} from './store.js';
import type { SessionHandoff } from './handoff.js';
import { search, markRetrieved, estimateTokens, hybridSearch, physicsSearch, explainMatch, textOverlap, type RerankStep } from './search.js';
import { renderTraceContent, parseSteps } from './trace.js';
import { consolidate } from './consolidate.js';
import { deduplicateStore } from './dedupe.js';
import {
  isEmbeddingAvailable,
  embedAll,
  embedMemory,
  loadEmbeddingIndex,
  resolveEmbeddingModel,
  embeddingModelRequiresReindex,
} from './embeddings.js';
import { isEmbeddingConfigured, resolveEmbeddingProvider } from './embedding-provider.js';
import { loadPhysicsState, resetAllPhysicsState } from './physics-state.js';
import { computeSystemEnergy, vecNorm } from './physics.js';
import { loadConfig } from './config.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { getActiveGoalsWithDb, MAX_FINAL_MULTIPLIER, pushGoal, getActiveGoals, completeGoal, suspendGoal, resumeGoal, applyGoalStackBoost } from './goals.js';
import type { RetrievalPolicy, PolicyType, Goal, GoalRow } from './goals.js';
import { rowToGoal } from './goals.js';
import {
  captureError,
  extractLessons,
  deduplicateLesson,
  runWatched,
  fetchGitLog,
  isGitRepo,
} from './autolearn.js';
import { extractInvalidationTarget, invalidateMatching, InvalidationTarget } from './invalidation.js';
import { extractPathTags } from './path-context.js';
import { detectScope, scopeMatch } from './scope.js';
import {
  getGlobalRoot,
  initGlobal,
  promoteToGlobal,
  shareMemory,
  listPeers,
  autoShare,
  transferScore,
  searchBoth,
  searchBothHybrid,
  syncGlobalToLocal,
} from './shared.js';
import {
  DAILY_TASK_NAME,
  buildDailyRunnerCommand,
  listRegisteredWorkspaces,
  registerWorkspace,
  runDailyMaintenance,
} from './scheduler.js';
import {
  importChatGPT,
  importClaude,
  importCursor,
  importGenericFile,
  importMarkdown,
  importVault,
  ImportOptions,
} from './importers.js';
import { cmdCapture, CaptureOptions } from './capture.js';
import {
  auditMemories,
  appendAuditEvent,
  queryAuditEvents,
  type AuditEvent,
  type AuditOp,
  type AuditResult,
} from './audit.js';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyListItem } from './auth.js';
import { buildProvenanceCoverage } from './provenance-coverage.js';
import { buildCorrectionLatency } from './correction-latency.js';
import * as api from './api.js';
import * as predictionsModule from './predictions.js';
import { computePlanningFallacyOutput } from './predictions.js';
import * as decisionsModule from './decisions.js';
import * as incidentsModule from './incidents.js';
import * as processesModule from './processes.js';
import * as policiesModule from './policies.js';
import * as skillsModule from './skills.js';
import * as briefsModule from './project-briefs.js';
import * as customerNotesModule from './customer-notes.js';
import { extractGraph } from './graph-extract.js';
import { buildGraphModel, renderGraphHtml, renderGraphCanvas, DEFAULT_VIEW_LIMIT } from './graph-view.js';
import { createHash } from 'node:crypto';
import {
  detectAnchoring,
  hashQueryText,
  buildSessionKey,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  RingBuffer,
  type AnchoringHint,
} from './recall-history.js';
import { detectAvailabilityBias, type AvailabilityHint } from './availability.js';

// v0.33 / J1 — Module-level per-(tenant, session) recall-history ring map.
// Each CLI process maintains its OWN Map; no IPC / no cross-process sharing
// (plan v3 decision: per-pipeline rings, see docs/plans/2026-05-26-j1-anchoring-detector.md).
//
// IMPORTANT single-shot CLI limitation (codex round-2 catch): in normal
// terminal usage each `hippo recall` invocation spawns a fresh Node
// process, so this Map is recreated empty every time and J1 cannot
// accumulate history across invocations. CLI J1 only fires in
// long-running processes (the cmdSleep / consolidate loops, batch
// scripts that call cmdRecall in-process, or tests). MCP and HTTP
// pipelines DO accumulate because their host processes are long-lived
// (hippo serve, MCP server). For CLI users who want per-session
// anchoring in single-shot mode, the recommendation is to run via
// `hippo serve` and call HTTP /v1/memories?session_id=... (the HTTP
// ring persists across calls within the server process). A J1-v1.1
// follow-up may add SQLite-backed CLI persistence (migration v30
// recall_history table per the original brainstorm option D).
const sessionRecallHistoryCli = new Map<string, RingBuffer>();

/** Test-only: reset the module-level recall-history Map. Call from beforeEach. */
export function __resetSessionRecallHistoryCli(): void {
  sessionRecallHistoryCli.clear();
}
import * as client from './client.js';
import { detectServer, removePidfileIfOwned, type ServerInfo } from './server-detect.js';
import { resolveTenantId } from './tenant.js';
import { runEval, bootstrapCorpus, compareSummaries, type EvalCase, type EvalSummary } from './eval.js';
import { runFeatureEval, formatResult, resultToBaseline, detectRegressions, type EvalBaseline } from './eval-suite.js';
import { refineStore } from './refine-llm.js';
import { wmPush, wmRead, wmClear, wmFlush, WorkingMemoryItem } from './working-memory.js';
import { multihopSearch } from './multihop.js';
import { graphExpandRecall, MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from './graph-recall.js';
import { DEFAULT_GRAPH_STREAM_WEIGHT } from './graph-stream.js';
import { getReranker } from './rerankers/index.js';
import { computeSalience } from './salience.js';
import { computeAmbientState, renderAmbientSummary } from './ambient.js';
import { validateOwner, isStrictOwnerEnv } from './owner-validation.js';
import { pruneAuditLog, parseOlderThanFlag } from './audit-prune.js';
import { listDlq, replayDlqEntry } from './connectors/slack/dlq.js';
import { backfillChannel } from './connectors/slack/backfill.js';
import { slackHistoryFetcher } from './connectors/slack/web-client.js';
import {
  addWorkspace as addSlackWorkspace,
  listWorkspaces as listSlackWorkspaces,
  removeWorkspace as removeSlackWorkspace,
} from './connectors/slack/workspaces.js';
import { cmdGithub } from './connectors/github/cli-impl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLimitFlag(value: string | boolean | string[] | undefined): number {
  if (!value) return Infinity;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : Infinity;
}

function parseCountFlag(value: string | boolean | string[] | undefined): number {
  if (!value || value === true || Array.isArray(value)) return 0;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 0;
}

/**
 * Emit an audit event against `hippoRoot`'s db. Opens its own short-lived
 * connection so callers don't have to thread a db handle. Swallows all errors
 * — audit must never crash a CLI command.
 */
function emitCliAudit(
  hippoRoot: string,
  op: AuditOp,
  targetId?: string,
  metadata?: Record<string, unknown>,
): void {
  try {
    const db = openHippoDb(hippoRoot);
    try {
      appendAuditEvent(db, {
        tenantId: resolveTenantId({}),
        actor: 'cli',
        op,
        targetId,
        metadata,
      });
    } finally {
      closeHippoDb(db);
    }
  } catch {
    // Audit is best-effort; surface failures only via missing rows.
  }
}

function requireInit(hippoRoot: string): void {
  if (!isInitialized(hippoRoot)) {
    console.error('No .hippo directory found. Run `hippo init` first.');
    process.exit(1);
  }
}

/**
 * H2: when HIPPO_REQUIRE_SERVER is set, the CLI must not silently fall back to
 * direct DB mode — a missing server then masks a real misconfiguration (the
 * configured HIPPO_API_KEY is also silently discarded on fallback). Throws a
 * clear, actionable error in that case; a no-op when the knob is unset, so
 * default behaviour is unchanged.
 */
function failIfServerRequired(reason: string): void {
  if (process.env['HIPPO_REQUIRE_SERVER']) {
    throw new Error(
      `hippo: HIPPO_REQUIRE_SERVER is set but ${reason}. ` +
      `Start \`hippo serve\`, or unset HIPPO_REQUIRE_SERVER to allow direct-mode fallback.`,
    );
  }
}

/**
 * Run an HTTP-routed command if a `hippo serve` instance is detected for
 * `hippoRoot`. Returns:
 *   - true  if the HTTP path ran (success OR a structured server error that
 *           was already surfaced to stdout/stderr by `httpFn`),
 *   - false if no server was detected, or if the detected pidfile turned out
 *           to be stale (connection refused). On stale, the pidfile is removed
 *           if it still names that dead server (a newer one may have replaced
 *           it) and the caller should fall back to the direct path.
 *
 * Per the A1 plan footgun #1: stale pidfiles must self-heal, not crash.
 * H2: when HIPPO_REQUIRE_SERVER is set, both fallback paths throw instead of
 * returning false, so a missing server fails loudly rather than silently
 * degrading to direct mode.
 */
async function runViaServerIfAvailable(
  hippoRoot: string,
  httpFn: (info: ServerInfo, apiKey: string | undefined) => Promise<void>,
): Promise<boolean> {
  const info = await detectServer(hippoRoot);
  if (!info) {
    failIfServerRequired('no running server was detected for this hippoRoot');
    return false;
  }
  const apiKey = process.env['HIPPO_API_KEY'];
  try {
    await httpFn(info, apiKey);
    return true;
  } catch (err) {
    if (client.isConnectionRefused(err)) {
      failIfServerRequired('the server pidfile was stale (connection refused)');
      console.error('hippo: stale server pidfile detected, falling back to direct mode');
      // Clear the pidfile only if it still names the dead server we just
      // probed — a newer server may have rewritten it (removePidfileIfOwned).
      removePidfileIfOwned(hippoRoot, { pid: info.pid, startedAt: info.started_at });
      return false;
    }
    throw err;
  }
}

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean | string[]> } {
  const [, , command = '', ...rest] = argv;
  const args: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  let i = 0;
  while (i < rest.length) {
    const part = rest[i];
    if (part === '--') {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (part.startsWith('--')) {
      const key = part.slice(2);
      const next = rest[i + 1];

      if (!next || next.startsWith('--')) {
        // Boolean flag
        flags[key] = true;
        i++;
      } else {
        // Check if it's a repeatable flag (tag, artifact, link, step)
        if (key === 'tag' || key === 'artifact' || key === 'link' || key === 'step') {
          if (Array.isArray(flags[key])) {
            (flags[key] as string[]).push(next);
          } else {
            flags[key] = [next];
          }
        } else {
          flags[key] = next;
        }
        i += 2;
      }
    } else {
      args.push(part);
      i++;
    }
  }

  return { command, args, flags };
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

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

function cmdInitScan(scanDir: string, flags: Record<string, string | boolean | string[]>): void {
  const resolved = path.resolve(scanDir);
  console.log(`Scanning ${resolved} for git repositories...\n`);

  const repos = scanForGitRepos(resolved);
  if (repos.length === 0) {
    console.log('No git repositories found.');
    return;
  }

  console.log(`Found ${repos.length} repositories:\n`);

  // Init global store first
  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    initGlobal();
    console.log(`Initialized global store at ${globalRoot}\n`);
  }

  let totalLessons = 0;
  const seedDays = parseInt(String(flags['days'] ?? '365'), 10);

  for (const repo of repos) {
    const name = path.basename(repo);
    const repoHippo = path.join(repo, '.hippo');
    const alreadyExists = isInitialized(repoHippo);

    if (!alreadyExists) {
      initStore(repoHippo);
    }

    registerWorkspace(globalRoot, repo);

    // Learn from git history
    let added = 0;
    if (!flags['no-learn'] && isGitRepo(repo)) {
      const result = learnFromRepo(repoHippo, repo, seedDays, name);
      added = result.added;
      totalLessons += added;
    }

    const status = alreadyExists ? 'existing' : 'new';
    const entries = loadAllEntries(repoHippo);
    console.log(`  ${name.padEnd(25)} ${status.padEnd(10)} ${entries.length} memories${added > 0 ? ` (+${added} from git)` : ''}`);
  }

  console.log(`\n${repos.length} repositories, ${totalLessons} new lessons learned.`);
  console.log(`Global store: ${globalRoot}`);
  if (!flags['no-schedule']) {
    setupDailySchedule(globalRoot);
  }
  console.log(`\nRun \`hippo sleep\` in any project to consolidate and auto-share to global.`);
}

function cmdInit(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  // Handle --scan mode
  if (flags['scan']) {
    const scanDir = typeof flags['scan'] === 'string' ? flags['scan'] : os.homedir();
    cmdInitScan(scanDir, flags);
    return;
  }

  if (flags['global']) {
    const globalRoot = getGlobalRoot();
    if (isInitialized(globalRoot)) {
      console.log('Already initialized global store at', globalRoot);
      return;
    }
    initGlobal();
    console.log('Initialized global Hippo store at', globalRoot);
    return;
  }

  const alreadyExists = isInitialized(hippoRoot);
  if (alreadyExists) {
    console.log('Already initialized at', hippoRoot);
  } else {
    initStore(hippoRoot);
    console.log('Initialized Hippo at', hippoRoot);
    console.log('   Directories: buffer/ episodic/ semantic/ conflicts/');
    console.log('   Files: hippo.db index.json stats.json');
  }

  const globalRoot = getGlobalRoot();
  registerWorkspace(globalRoot, path.dirname(hippoRoot));

  // Auto-detect and install hooks (unless --no-hooks)
  if (!flags['no-hooks']) {
    autoInstallHooks(alreadyExists);
  }

  // Auto-setup daily schedule (unless --no-schedule)
  if (!flags['no-schedule'] && !flags['global']) {
    setupDailySchedule(globalRoot);
  }

  // Seed with git history on first init (unless --no-learn)
  if (!alreadyExists && !flags['no-learn'] && !flags['global']) {
    if (isGitRepo(process.cwd())) {
      const seedDays = 30;
      console.log(`\n   Seeding memories from last ${seedDays} days of git history...`);
      const { added, skipped } = learnFromRepo(hippoRoot, process.cwd(), seedDays);
      if (added > 0) {
        console.log(`   Learned ${added} lessons from git (${skipped} duplicates skipped).`);
      } else {
        console.log(`   No matching commits found in git history.`);
      }
    }

    // Also import from Claude Code / agent MEMORY.md files
    const memImported = learnFromMemoryMd(hippoRoot);
    if (memImported > 0) {
      console.log(`   Imported ${memImported} memories from agent MEMORY.md files.`);
    }
  }
}

/**
 * Detect agent config files in cwd and auto-install hippo hooks.
 * Skips files that already have a <!-- hippo:start --> block.
 */
function autoInstallHooks(quiet: boolean): void {
  const cwd = process.cwd();

  // Map: filename to check -> hook key(s) to install
  const detectors: Array<{ files: string[]; hook: string }> = [
    { files: ['CLAUDE.md', '.claude/settings.json'], hook: 'claude-code' },
    { files: ['AGENTS.md', '.codex'], hook: 'codex' },
    { files: ['.cursorrules', '.cursor/rules'], hook: 'cursor' },
    { files: ['.openclaw', 'AGENTS.md'], hook: 'openclaw' },
    { files: ['.opencode', 'opencode.json'], hook: 'opencode' },
    { files: ['.pi', '.pi/agent'], hook: 'pi' },
  ];

  // Track which hook files we've already touched to avoid double-patching AGENTS.md
  const installed = new Set<string>();

  for (const { files, hook } of detectors) {
    const hookDef = HOOKS[hook];
    if (!hookDef) continue;

    // Check if any marker file exists
    const detected = files.some((f) => fs.existsSync(path.join(cwd, f)));
    if (!detected) continue;

    const targetPath = path.resolve(cwd, hookDef.file);

    // Skip if we already installed a hook into this file
    if (installed.has(targetPath)) continue;

    // Skip if hook already present
    if (fs.existsSync(targetPath)) {
      const content = fs.readFileSync(targetPath, 'utf8');
      if (content.includes(HOOK_MARKERS.start)) continue;
    }

    // Only patch the agent-instructions file if it already exists.
    // Never create a new CLAUDE.md / AGENTS.md / etc. just because a sibling
    // marker file (.claude/settings.json, .codex, etc.) was detected — that
    // pollutes dirs the user didn't intend to configure.
    if (fs.existsSync(targetPath)) {
      const block = `${HOOK_MARKERS.start}\n${hookDef.content}\n${HOOK_MARKERS.end}`;
      const existing = fs.readFileSync(targetPath, 'utf8');
      const sep = existing.endsWith('\n') ? '\n' : '\n\n';
      fs.writeFileSync(targetPath, existing + sep + block + '\n', 'utf8');
      installed.add(targetPath);
      console.log(`   Auto-installed ${hook} hook in ${hookDef.file}`);
    }

    // For Claude Code, also install SessionEnd+SessionStart entries in its
    // settings.json. Keeps `hippo init` in lockstep with `hippo hook install
    // claude-code` and `hippo setup`.
    if (hook === 'claude-code') {
      const result = installJsonHooks(hook);
      if (result.installedSessionEnd) {
        console.log(`   Auto-installed hippo session-end SessionEnd hook in ${hook} settings`);
      }
      if (result.installedSessionStart) {
        console.log(`   Auto-installed hippo last-sleep SessionStart hook in ${hook} settings`);
      }
      if (result.installedUserPromptSubmit) {
        console.log(`   Auto-installed hippo pinned-inject UserPromptSubmit hook in ${hook} settings`);
      }
      if (result.migratedFromStop) {
        console.log(`   Migrated legacy Stop hook → SessionEnd (no longer runs every turn)`);
      }
      if (result.migratedSplitSessionEnd) {
        console.log(`   Migrated split sleep+capture SessionEnd entries → single detached hippo session-end`);
      } else if (result.migratedLegacySessionEnd) {
        console.log(`   Migrated legacy SessionEnd entry to the new detached form`);
      }
    } else if (hook === 'opencode') {
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
  }
}

/**
 * Set up a machine-level daily runner that sweeps all registered Hippo
 * workspaces.
 * Linux/macOS: writes to user crontab.
 * Windows: creates a scheduled task.
 * Skips if already installed.
 */
function setupDailySchedule(globalRoot: string): void {
  const runnerDir = path.resolve(globalRoot);
  // Reject paths with characters that could break shell/crontab quoting
  // (backslash is normal on Windows, only dangerous in Unix shell/crontab)
  const unsafeChars = process.platform === 'win32' ? /["`$%\n\r]/ : /["`$\n\r\\]/;
  if (unsafeChars.test(runnerDir)) {
    console.log(`   Skipping schedule: runner path contains unsafe characters.`);
    return;
  }
  const isWindows = process.platform === 'win32';
  const taskName = DAILY_TASK_NAME;
  const cmd = buildDailyRunnerCommand(runnerDir);

  if (isWindows) {
    // Check if task already exists
    try {
      const existing = execSync(`schtasks /query /tn "${taskName}" 2>nul`, { encoding: 'utf-8' });
      if (existing.includes(taskName)) {
        return; // already scheduled
      }
    } catch {
      // Task doesn't exist, create it
    }

    try {
      execSync(
        `schtasks /create /tn "${taskName}" /tr "cmd /c ${cmd.replace(/"/g, '""')}" /sc daily /st 06:15 /f`,
        { stdio: 'pipe' }
      );
      console.log(`   Scheduled machine-level daily runner (6:15am) via Task Scheduler: ${taskName}`);
    } catch {
      // No admin rights or schtasks unavailable, fall back to printing instructions
      console.log(`   To schedule the machine-level daily runner, run:`);
      console.log(`   schtasks /create /tn "${taskName}" /tr "cmd /c ${cmd}" /sc daily /st 06:15`);
    }
  } else {
    // Unix: check crontab for existing entry
    const marker = `# hippo:${taskName}`;
    try {
      const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf-8' });
      if (existing.includes(marker)) {
        return; // already scheduled
      }

      const cronLine = `15 6 * * * ${cmd} ${marker}`;
      const newCrontab = existing.trimEnd() + '\n' + cronLine + '\n';
      execSync('crontab -', { input: newCrontab, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`   Scheduled machine-level daily runner (6:15am) via crontab`);
    } catch {
      const cronLine = `15 6 * * * ${cmd}`;
      console.log(`   To schedule the machine-level daily runner, add to crontab (crontab -e):`);
      console.log(`   ${cronLine}`);
    }
  }
}

async function cmdRemember(
  hippoRoot: string,
  text: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const useGlobal = Boolean(flags['global']);
  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const rawTags: string[] = Array.isArray(flags['tag']) ? flags['tag'] as string[] : [];
  if (flags['error']) rawTags.push('error');

  // Resolve explicit confidence flag (default: 'verified' for manual remember)
  let confidence: ConfidenceLevel = 'verified';
  if (flags['observed']) confidence = 'observed';
  if (flags['inferred']) confidence = 'inferred';
  if (flags['verified']) confidence = 'verified';

  // Compute schema fit against existing memories
  const existing = loadAllEntries(targetRoot);
  const schemaFit = computeSchemaFit(text, rawTags, existing);

  // A3 envelope flags
  const kindFlagRaw = typeof flags['kind'] === 'string' ? (flags['kind'] as string) : undefined;
  const kindFlag = kindFlagRaw === undefined ? undefined : kindFlagRaw.toLowerCase();
  // CLI surface intentionally restricted: 'raw' is reserved for ingestion connectors
  // (E1.x: Slack/Jira/Gmail) that route deletions through archiveRawMemory. Existing
  // forget/consolidate/conflict-resolve paths abort on kind='raw' via the append-only
  // trigger, so exposing --kind raw here would create unforgettable memories.
  // 'archived' is an internal sentinel set only inside archiveRawMemory's transaction.
  const userVisibleKinds = ['distilled', 'superseded'] as const;
  if (kindFlag !== undefined && !(userVisibleKinds as readonly string[]).includes(kindFlag)) {
    console.error(`Invalid --kind: "${kindFlagRaw}". Must be one of: ${userVisibleKinds.join(', ')}`);
    console.error(`(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)`);
    process.exit(1);
  }
  const ownerRaw = typeof flags['owner'] === 'string' ? (flags['owner'] as string) : null;
  const ownerCheck = validateOwner(ownerRaw, { strict: isStrictOwnerEnv() });
  if (!ownerCheck.ok) {
    console.error(ownerCheck.message);
    process.exit(1);
  }
  if (ownerCheck.message) console.error(ownerCheck.message);
  const ownerFlag = ownerCheck.value ?? null;
  const artifactRefFlag = typeof flags['artifact-ref'] === 'string' ? (flags['artifact-ref'] as string) : null;
  const scopeForEnvelope = typeof flags['scope'] === 'string' ? (flags['scope'] as string).trim() || null : null;

  // A5 stub auth: stamp tenant_id from env (HIPPO_TENANT) so recall isolation
  // can filter on this row. Default tenant 'default' for unauthenticated CLI.
  const tenantId = resolveTenantId({});

  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: rawTags,
    pinned: Boolean(flags['pin']),
    source: useGlobal ? 'cli-global' : 'cli',
    confidence,
    schema_fit: schemaFit,
    kind: kindFlag as ('raw' | 'distilled' | 'superseded' | 'archived' | undefined),
    scope: scopeForEnvelope,
    owner: ownerFlag,
    artifact_ref: artifactRefFlag,
    tenantId,
  });

  // Auto-tag with path context
  const pathTags = extractPathTags(process.cwd());
  for (const pt of pathTags) {
    if (!entry.tags.includes(pt)) entry.tags.push(pt);
  }

  // Scope tagging: explicit --scope or auto-detected
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const activeScope = explicitScope || detectScope();
  if (activeScope) {
    const scopeTag = `scope:${activeScope}`;
    if (!entry.tags.includes(scopeTag)) entry.tags.push(scopeTag);
  }

  // Salience gate: decide if this memory is worth storing
  const rememberConfig = loadConfig(targetRoot);
  if (rememberConfig.salience.enabled && !Boolean(flags['pin']) && !Boolean(flags['force'])) {
    const salienceResult = computeSalience(text, entry.tags, existing, {
      recentWindow: rememberConfig.salience.recentWindow,
      overlapThreshold: rememberConfig.salience.overlapThreshold,
      minContentLength: rememberConfig.salience.minContentLength,
      maxRepeatErrors: rememberConfig.salience.maxRepeatErrors,
    });
    if (salienceResult.decision === 'skip') {
      console.log(`Skipped (salience: ${salienceResult.reason}, score ${salienceResult.score.toFixed(2)})`);
      return;
    }
    if (salienceResult.decision === 'start_weak') {
      entry.strength = salienceResult.score;
      entry.half_life_days = Math.max(1, entry.half_life_days * 0.5);
      console.log(`Weakened (salience: ${salienceResult.reason}, strength ${salienceResult.score.toFixed(2)})`);
    }
  }

  writeEntry(targetRoot, entry);
  updateStats(targetRoot, { remembered: 1 });

  const prefix = useGlobal ? '[global] ' : '';
  console.log(`${prefix}Remembered [${entry.id}]`);
  console.log(`   Layer: ${entry.layer} | Strength: ${fmt(entry.strength)} | Half-life: ${entry.half_life_days}d | Confidence: ${entry.confidence}`);
  if (entry.tags.length > 0) console.log(`   Tags: ${entry.tags.join(', ')}`);
  if (entry.pinned) console.log('   Pinned (no decay)');

  // Auto-embed if available (provider-aware: local dep installed, or API key present)
  if (isEmbeddingConfigured(targetRoot)) {
    embedMemory(targetRoot, entry).catch(() => {
      // Silently ignore embedding errors
    });
  }

  const config = loadConfig(targetRoot);
  const shouldExtract = flags['extract'] || config.extraction.enabled === true;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  if (shouldExtract && apiKey) {
    try {
      const { extractFacts, storeExtractedFacts } = await import('./extract.js');
      const facts = await extractFacts(entry.content, {
        apiKey,
        model: config.extraction.model,
      });
      if (facts.length > 0) {
        storeExtractedFacts(targetRoot, entry, facts);
        console.error(`  extracted ${facts.length} fact(s)`);
      }
    } catch {
      // Extraction is best-effort — never block remember
    }
  } else if (shouldExtract && !apiKey) {
    console.error('  (extraction skipped: ANTHROPIC_API_KEY not set)');
  }
}

function cmdSupersede(
  hippoRoot: string,
  oldId: string,
  newContent: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);

  const old = readEntry(hippoRoot, oldId, resolveTenantId({}));
  if (!old) {
    console.error(`Error: memory ${oldId} not found.`);
    process.exit(1);
  }
  if (old.superseded_by) {
    console.error(`Error: memory ${oldId} is already superseded by ${old.superseded_by}. Supersede that one instead.`);
    process.exit(1);
  }

  const layer = (typeof flags['layer'] === 'string' ? flags['layer'] : old.layer) as Layer;
  const rawTags = flags['tag'];
  const tags = Array.isArray(rawTags)
    ? (rawTags as string[]).map((t) => String(t))
    : typeof rawTags === 'string'
      ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      : [...old.tags];
  const pinned = flags['pin'] === true || old.pinned;

  const newEntry = createMemory(newContent, {
    layer,
    tags,
    pinned,
    source: old.source,
    confidence: 'verified',
  });

  old.superseded_by = newEntry.id;
  writeEntry(hippoRoot, old);
  writeEntry(hippoRoot, newEntry);
  emitCliAudit(hippoRoot, 'supersede', oldId, { newId: newEntry.id });

  console.log(`Superseded ${oldId} → ${newEntry.id}`);
}

async function cmdRecall(
  hippoRoot: string,
  query: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseInt(String(flags['budget'] ?? '4000'), 10);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const showWhy = Boolean(flags['why']);
  const forcePhysics = Boolean(flags['physics']);
  const forceClassic = Boolean(flags['classic']);
  const includeSuperseded = Boolean(flags['include-superseded']);
  const asOf = typeof flags['as-of'] === 'string' ? flags['as-of'] : undefined;
  if (asOf !== undefined && Number.isNaN(new Date(asOf).getTime())) {
    console.error(`Error: --as-of value "${asOf}" is not a valid ISO date (e.g. 2026-04-22 or 2026-04-22T12:00:00Z).`);
    process.exit(1);
  }
  const globalRoot = getGlobalRoot();

  // A5 stub auth: resolve the active tenant once and thread it through every
  // recall-time SELECT against `memories`. Cross-tenant rows must never surface.
  const tenantId = resolveTenantId({});

  let localEntries = loadSearchEntries(hippoRoot, query, undefined, tenantId);
  let globalEntries = isInitialized(globalRoot) ? loadSearchEntries(globalRoot, query, undefined, tenantId) : [];

  // v1.12.13 / C5 — WYSIATI counters. Track filter activity per the plan v3
  // Task 3 mapping table. dropped_pre_rank is the SUM of all non-budget
  // filter drops (pre-rank AND post-rank). Search-engine internal drops
  // (scored-to-zero rows that hybridSearch/physicsSearch returns fewer of)
  // are NOT counted in v1 — they are part of the rank step, not a filter.
  const totalCandidatesCountCmd = localEntries.length + globalEntries.length;
  let droppedPreRankCountCmd = 0;

  // Bi-temporal filtering for physics path (hybridSearch handles it internally)
  if (asOf) {
    const filterAsOf = (entries: MemoryEntry[]) => {
      const asOfDate = new Date(asOf);
      const successorValidFrom = new Map<string, string>();
      for (const e of entries) {
        if (e.superseded_by) {
          const successor = entries.find(s => s.id === e.superseded_by);
          if (successor) successorValidFrom.set(e.id, successor.valid_from);
        }
      }
      return entries.filter(e => {
        if (new Date(e.valid_from) > asOfDate) return false;
        if (!e.superseded_by) return true;
        const succVf = successorValidFrom.get(e.id);
        return succVf ? new Date(succVf) > asOfDate : true;
      });
    };
    const beforeAsOf = localEntries.length + globalEntries.length;
    localEntries = filterAsOf(localEntries);
    globalEntries = filterAsOf(globalEntries);
    droppedPreRankCountCmd += beforeAsOf - (localEntries.length + globalEntries.length);
  } else if (!includeSuperseded) {
    const beforeSupersededDrop = localEntries.length + globalEntries.length;
    localEntries = localEntries.filter(e => !e.superseded_by);
    globalEntries = globalEntries.filter(e => !e.superseded_by);
    droppedPreRankCountCmd += beforeSupersededDrop - (localEntries.length + globalEntries.length);
  }

  const hasGlobal = globalEntries.length > 0;

  // Determine search mode: --physics forces physics, --classic forces BM25+cosine,
  // default uses physics if config.physics.enabled is not false
  const config = loadConfig(hippoRoot);
  const usePhysics = forcePhysics
    || (!forceClassic && config.physics.enabled !== false);

  const noMmr = Boolean(flags['no-mmr']);
  const mmrLambda = flags['mmr-lambda'] !== undefined
    ? parseFloat(String(flags['mmr-lambda']))
    : config.mmr.lambda;
  const mmrEnabled = !noMmr && config.mmr.enabled;
  const localBump = flags['equal-sources']
    ? 1.0
    : flags['local-bump'] !== undefined
      ? parseFloat(String(flags['local-bump']))
      : config.search.localBump;
  const minResults = flags['min-results'] !== undefined
    ? parseInt(String(flags['min-results']), 10)
    : undefined;
  const recallExplicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const recallActiveScope = recallExplicitScope || detectScope();

  const useMultihop = flags['multihop'] === true || config.multihop.enabled;

  // L1 — graph-retrieval stream. `--graph-stream` forces rrf fusion + the graph stream
  // (see src/graph-stream.ts). NOTE: it implies `scoring:'rrf'` (production default is
  // 'blend'), so the flag bundles two behaviours by design. CLI surface is local-store
  // only for now; the library API supports a globalRoot for callers who need it.
  const useGraphStream = flags['graph-stream'] === true;
  let graphStreamHops: number | undefined;
  if (useGraphStream && flags['graph-hops'] !== undefined) {
    if (typeof flags['graph-hops'] === 'boolean') {
      console.error(`--graph-hops requires an integer value 1..${MAX_HOPS} (e.g. --graph-hops 2).`);
      process.exit(1);
    }
    const h = Number(flags['graph-hops']);
    if (!Number.isInteger(h) || h < 1 || h > MAX_HOPS) {
      console.error(`Invalid --graph-hops: "${String(flags['graph-hops'])}". Must be an integer 1..${MAX_HOPS}.`);
      process.exit(1);
    }
    graphStreamHops = h;
  }
  let graphStreamSeeds: number | undefined;
  if (useGraphStream && flags['graph-seeds'] !== undefined) {
    if (typeof flags['graph-seeds'] === 'boolean') {
      console.error('--graph-seeds requires a positive integer value (e.g. --graph-seeds 10).');
      process.exit(1);
    }
    const s = Number(flags['graph-seeds']);
    if (!Number.isInteger(s) || s < 1) {
      console.error(`Invalid --graph-seeds: "${String(flags['graph-seeds'])}". Must be a positive integer.`);
      process.exit(1);
    }
    graphStreamSeeds = s;
  }

  let results;
  if (useGraphStream) {
    if (!isEmbeddingAvailable()) {
      // The graph stream fuses inside the rrf path, which only runs with embeddings; without
      // them hybridSearch falls back to BM25-only and the stream is inert. Say so plainly
      // rather than silently no-op.
      console.error('[note] --graph-stream needs embeddings (rrf fusion); none available, so the graph stream is inert. Run `hippo embed` first.');
    }
    if (hasGlobal) {
      console.error('[note] --graph-stream searches the local store only; global graph fusion is a follow-up.');
    }
    // The stream anchors on the top-`seedCount` lexical hits and re-ranks the rank>seedCount
    // tail; on a pool with <= seedCount candidates EVERY candidate is a seed and the stream
    // is inert (it degrades to the 2-list fusion). Tune the anchor count with --graph-seeds.
    results = await hybridSearch(query, localEntries, {
      budget, hippoRoot, mmr: mmrEnabled, mmrLambda, minResults, scope: recallActiveScope,
      includeSuperseded, asOf,
      scoring: 'rrf',
      graphStream: { weight: DEFAULT_GRAPH_STREAM_WEIGHT, tenantId, hops: graphStreamHops, seedCount: graphStreamSeeds },
    });
  } else if (useMultihop) {
    const allEntries = [...localEntries, ...globalEntries];
    results = multihopSearch(query, allEntries, {
      budget,
      hippoRoot,
      minResults,
      includeSuperseded,
      asOf,
    });
  } else if (usePhysics && !hasGlobal) {
    results = await physicsSearch(query, localEntries, {
      budget,
      hippoRoot,
      physicsConfig: config.physics,
      minResults,
      scope: recallActiveScope,
      includeSuperseded,
      asOf,
    });
  } else if (hasGlobal) {
    // Use searchBothHybrid for merged results with embedding support
    results = await searchBothHybrid(query, hippoRoot, globalRoot, {
      budget, mmr: mmrEnabled, mmrLambda, localBump, minResults, scope: recallActiveScope, tenantId,
      includeSuperseded, asOf,
    });
  } else {
    results = await hybridSearch(query, localEntries, {
      budget, hippoRoot, mmr: mmrEnabled, mmrLambda, minResults, scope: recallActiveScope,
      includeSuperseded, asOf,
    });
  }

  // E3.2 multi-hop graph recall. After the base branch produces `results`, optionally
  // augment with memories reached by walking the entities/relations graph `--hops N` out
  // from the lexical seeds. Runs BEFORE the opt-in re-rankers below so graph-reached
  // results are first-class candidates in any downstream re-ranking / --why. Default OFF
  // (absent or 0 = no-op). Reached memories are loaded directly by id (NOT via the
  // lexical candidate set, which would exclude the orthogonal neighbours graph recall
  // exists to surface); the engine re-applies the same superseded/asOf hard filters.
  if (flags['hops'] !== undefined) {
    // Reject a value-less `--hops` (parseArgs stores boolean true): Number(true) === 1
    // would otherwise silently run a 1-hop expansion when the user fat-fingered the value.
    if (typeof flags['hops'] === 'boolean') {
      console.error(`--hops requires an integer value 0..${MAX_HOPS} (e.g. --hops 1).`);
      process.exit(1);
    }
    const hops = Number(flags['hops']);
    if (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS) {
      console.error(`Invalid --hops: "${String(flags['hops'])}". Must be an integer 0..${MAX_HOPS}.`);
      process.exit(1);
    }
    let maxNeighbors = DEFAULT_MAX_NEIGHBORS;
    if (flags['max-neighbors'] !== undefined) {
      if (typeof flags['max-neighbors'] === 'boolean') {
        console.error(`--max-neighbors requires an integer value 1..200.`);
        process.exit(1);
      }
      maxNeighbors = Number(flags['max-neighbors']);
      if (!Number.isInteger(maxNeighbors) || maxNeighbors < 1 || maxNeighbors > 200) {
        console.error(`Invalid --max-neighbors: "${String(flags['max-neighbors'])}". Must be an integer 1..200.`);
        process.exit(1);
      }
    }
    if (hops > 0) {
      results = graphExpandRecall(results, {
        hops,
        maxNeighbors,
        hippoRoot,
        globalRoot: isInitialized(globalRoot) && globalRoot !== hippoRoot ? globalRoot : undefined,
        tenantId,
        includeSuperseded,
        asOf,
        budget,
        minResults: minResults ?? 1,
      });
    }
  }

  // ACC EVC-adaptive recall (RESEARCH.md §PFC.ACC). When the initial top-K is
  // dominated by lexically similar but distinct memories (high pairwise token
  // overlap = same topic, different facts = conflict), allocate extra retrieval
  // effort: take a wider candidate pool, drop low-relevance distractors, and
  // re-rank by recency to surface the most up-to-date item from the cluster.
  // Default off; opt-in via --evc-adaptive.
  if (flags['evc-adaptive'] && results.length >= 2) {
    const sliceSize = Math.min(3, results.length);
    const slice = results.slice(0, sliceSize);
    let pairs = 0;
    let overlapSum = 0;
    for (let i = 0; i < slice.length; i++) {
      for (let j = i + 1; j < slice.length; j++) {
        overlapSum += textOverlap(slice[i].entry.content, slice[j].entry.content);
        pairs++;
      }
    }
    const avgOverlap = pairs > 0 ? overlapSum / pairs : 0;
    if (avgOverlap >= 0.4) {
      const poolSize = Math.min(results.length, Math.max(sliceSize * 3, 9));
      const pool = results.slice(0, poolSize);
      const tail = results.slice(poolSize);
      const maxScore = pool.reduce((m, r) => Math.max(m, r.score), 0);
      const scoreFloor = maxScore * 0.5;
      const onTopic: typeof pool = [];
      const offTopic: typeof pool = [];
      for (const r of pool) {
        (r.score >= scoreFloor ? onTopic : offTopic).push(r);
      }
      onTopic.sort((a, b) => {
        const ta = new Date(a.entry.created).getTime();
        const tb = new Date(b.entry.created).getTime();
        return tb - ta;
      });
      results = [...onTopic, ...offTopic, ...tail];
    }
  }

  // vlPFC interference filter (RESEARCH.md §PFC.vlPFC). Suppress task-irrelevant
  // memories using *recorded* supersession + conflict structure only. Default
  // off; opt-in via --filter-conflicts. Two effects, both surgical:
  //   1. Drop entries with `superseded_by` set. (No-op under default recall,
  //      which already filters them; matters when `--include-superseded` was
  //      passed. The flag re-asserts the gate.)
  //   2. Apply a 0.3x score multiplier to entries whose `conflicts_with` list
  //      references another entry that ALSO appears in the result set. The
  //      multiplier is conservative — we never delete on conflict, only
  //      down-rank, so the user can still surface the loser via --include-*.
  // We never infer conflicts from lexical overlap. The v1 salience gate did
  // that and destroyed LoCoMo (0.28 → 0.02). Recorded structure only.
  if (flags['filter-conflicts']) {
    const beforeFilterConflicts = results.length;
    results = results.filter((r) => !r.entry.superseded_by);
    droppedPreRankCountCmd += beforeFilterConflicts - results.length;
    const presentIds = new Set(results.map((r) => r.entry.id));
    results = results.map((r) => {
      const peers = r.entry.conflicts_with || [];
      const hasPeerInResults = peers.some((peerId) => presentIds.has(peerId));
      if (!hasPeerInResults) return r;
      const next = { ...r, score: r.score * 0.3 };
      // A7 recall-trace: interference (vlPFC) down-rank. Only when --why.
      if (showWhy) {
        next.rerankTrace = [
          ...(r.rerankTrace ?? []),
          { stage: 'interference', multiplier: 0.3, scoreBefore: r.score, scoreAfter: next.score },
        ];
      }
      return next;
    });
    results.sort((a, b) => b.score - a.score);
  }

  // vmPFC continuous value attribution (RESEARCH.md §PFC.vmPFC). Continuous
  // value scoring per memory based on cumulative outcome attribution. Memories
  // with positive cumulative outcomes are boosted; those with negative outcomes
  // are demoted. The multiplier is a tanh-shaped function clamped to [0.7, 1.3]
  // — wider than the always-on outcomeBoost (which clamps [0.85, 1.15]) so this
  // flag has additional decisive effect when value attribution should drive
  // ranking. Default off; opt-in via --value-aware. Reuses outcome_positive /
  // outcome_negative columns; no schema change.
  if (flags['value-aware'] && results.length >= 1) {
    results = results.map((r) => {
      const pos = r.entry.outcome_positive ?? 0;
      const neg = r.entry.outcome_negative ?? 0;
      if (pos === 0 && neg === 0) return r;
      const raw = 1 + 0.3 * Math.tanh(pos - neg);
      const valueMult = Math.max(0.7, Math.min(1.3, raw));
      const next = { ...r, score: r.score * valueMult };
      // A7 recall-trace: vmPFC continuous value attribution. Only when --why.
      if (showWhy) {
        next.rerankTrace = [
          ...(r.rerankTrace ?? []),
          { stage: 'value', multiplier: valueMult, scoreBefore: r.score, scoreAfter: next.score },
        ];
      }
      return next;
    });
    results.sort((a, b) => b.score - a.score);
  }

  // OFC option-value re-ranker MVP (RESEARCH.md §PFC.OFC). Combine relevance,
  // strength, and integration cost into a single utility score and re-sort.
  // OFC neurons encode a "common currency" across heterogeneous attributes
  // (Rangel et al., 2008); this is the simplest demonstration of that mechanism.
  // Default off; opt-in via --rerank-utility.
  //
  //   utility = score * (0.5 + 0.5 * strength) * (1 - cost_factor)
  //   cost_factor = min(0.3, tokens / 10000)
  //
  // The full OFC spec (option_valuation table in RESEARCH.md) decomposes value
  // into reward / cost / risk / confidence components. The MVP collapses these
  // to: score (relevance proxy), strength (persistence proxy), tokens (cost).
  // CAVEAT: cost penalty is monotone with token count; LoCoMo's harder QAs
  // often live in long evidence-rich memories. Default off — needs LoCoMo
  // eval before enabling broadly.
  if (flags['rerank-utility']) {
    results = results
      .map((r) => {
        const strength = typeof r.entry.strength === 'number' ? r.entry.strength : 1.0;
        const costFactor = Math.min(0.3, (r.tokens || 0) / 10000);
        const utilityMult = (0.5 + 0.5 * strength) * (1 - costFactor);
        const utility = r.score * utilityMult;
        const next = { ...r, score: utility };
        // A7 recall-trace: OFC option-value re-rank. Only when --why.
        if (showWhy) {
          next.rerankTrace = [
            ...(r.rerankTrace ?? []),
            { stage: 'utility', multiplier: utilityMult, scoreBefore: r.score, scoreAfter: utility },
          ];
        }
        return next;
      })
      .sort((a, b) => b.score - a.score);
  }

  // F6 reranker pass (docs/plans/2026-05-10-f6-reranker-hardening.md). When
  // --reranker <name> is set, look up the reranker fn from the registry
  // (src/rerankers/index.ts) and apply it to the top-K candidates. The
  // reranker reorders (and may rescale) results; the post-budget set is
  // returned. Default off; opt-in via --reranker <cross-encoder|llm>. The
  // structurally similar --rerank-utility block above is the OFC MVP and is
  // independent — both can run in the same recall, with --rerank-utility
  // applied first. Available rerankers: cross-encoder, llm (see
  // src/rerankers/index.ts). The Track 1 `features` reranker was removed in
  // v1.9.1 per the F10 HARD RETRACTION; it is no longer a valid value.
  const rerankerName = flags['reranker'] !== undefined ? String(flags['reranker']).trim() : '';
  if (rerankerName) {
    const rerankerFn = getReranker(rerankerName);
    if (rerankerFn) {
      const topK = flags['reranker-top-k'] !== undefined
        ? parseInt(String(flags['reranker-top-k']), 10)
        : 50;
      const head = results.slice(0, topK);
      const tail = results.slice(topK);
      const rerankInput = head.map((r, i) => ({ ...r, preRerankRank: i + 1 }));
      const reranked = await rerankerFn(query, rerankInput, { topK });
      // Copy rerankScore into score so downstream blocks (--goal, goal-stack,
      // salience) that sort by `r.score` honor the reranker's order rather
      // than unwinding it. Original score is preserved on rerankScore's
      // input, but downstream sorters key on `score`.
      const withPostRank = reranked.map((r, i) => {
        const next = {
          ...r,
          score: r.rerankScore,
          postRerankRank: i + 1,
        };
        // A7 recall-trace: F6 reranker pass (reorder + rescale; not a scalar
        // multiply, so no multiplier field). Only when --why.
        if (showWhy) {
          next.rerankTrace = [
            ...(r.rerankTrace ?? []),
            { stage: 'reranker', scoreBefore: r.score, scoreAfter: r.rerankScore },
          ];
        }
        return next;
      });
      results = [...withPostRank, ...tail];
    }
  }

  // dlPFC goal-conditioned recall MVP (RESEARCH.md §PFC.dlPFC). When --goal
  // <tag> is set, memories whose `tags` array contains the goal tag receive
  // a 1.5x score boost and results are re-sorted. The full dlPFC spec
  // (goal_stack + retrieval_policy tables) maintains a hierarchical task
  // stack with weighted retrieval policies; this MVP collapses that to a
  // single-tag boost — the smallest demonstrable goal-conditioning signal.
  // Default off; opt-in via --goal <tag>. No schema change.
  const goalTag = flags['goal'] !== undefined ? String(flags['goal']).trim() : '';
  if (goalTag) {
    results = results
      .map((r) => {
        if (!r.entry.tags?.includes(goalTag)) return r;
        const boosted = { ...r, score: r.score * 1.5 };
        // A7 recall-trace: the explicit `--goal <tag>` boost is a public CLI
        // re-ranker (score *= 1.5) and is mutually exclusive with the session
        // goal-stack boost below, so it must record its OWN step or `--why
        // --goal` produces no ranking line (codex review). Stage `goal`
        // (explicit flag) is distinct from `goal-boost` (session stack).
        if (showWhy) {
          boosted.rerankTrace = [
            ...(r.rerankTrace ?? []),
            { stage: 'goal', multiplier: 1.5, scoreBefore: r.score, scoreAfter: r.score * 1.5, note: `--goal ${goalTag}` },
          ];
        }
        return boosted;
      })
      .sort((a, b) => b.score - a.score);
  }

  // dlPFC depth (B3, v0.38; lifted v1.7.4 into applyGoalStackBoost). When
  // HIPPO_SESSION_ID is set (env or --session-id flag) and the
  // (tenant, session) has active goals, the helper boosts memories whose tags
  // overlap any active goal's name and logs (memory, goal) pairs into
  // goal_recall_log. Runs AFTER the explicit `--goal <tag>` block so an
  // explicit flag always wins (gated on `goalTag === ''`).
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : process.env.HIPPO_SESSION_ID ?? ''
  ).trim();
  if (sessionId && goalTag === '') {
    const dbForGoals = openHippoDb(hippoRoot);
    // A7 recall-trace: goal-boost is the shared helper, not an inline map. It
    // writes its steps into this SEPARATE accumulator (keyed by entry id), NOT
    // onto the row (the helper strips internal markers on re-spread). Only
    // allocated under --why.
    const goalBoostTrace = showWhy ? new Map<string, RerankStep>() : undefined;
    try {
      results = applyGoalStackBoost(dbForGoals, results, {
        sessionId,
        tenantId,
        limit,
        ...(goalBoostTrace ? { trace: goalBoostTrace } : {}),
      });
    } finally {
      closeHippoDb(dbForGoals);
    }
    // Merge the accumulated goal-boost steps onto the matching SearchResult.
    if (goalBoostTrace && goalBoostTrace.size > 0) {
      results = results.map((r) => {
        const step = goalBoostTrace.get(r.entry.id);
        if (!step) return r;
        return { ...r, rerankTrace: [...(r.rerankTrace ?? []), step] };
      });
    }
  }

  // Pineal salience MVP (RESEARCH.md §"AI Pineal Gland — Intuition and Awareness
  // Module"). When --salience-threshold T is set (T > 0), memories whose
  // retrieval_count is below T are downweighted: score *= max(0.5, count / T).
  // At or above T, no change. This makes salience emerge from USE — high-recall
  // memories earn full ranking weight, low-recall memories are softly demoted.
  //
  // CRITICAL HISTORY: The v1 salience gate (60% lexical-overlap gate at memory
  // CREATION time) destroyed LoCoMo recall (0.28 -> 0.02) by dropping same-
  // session relevant turns at intake. See MEMORY.md "Hippo salience gate
  // destroys benchmark recall". This v2 is the inverse:
  //   - retrieval-side only (no creation-time gating)
  //   - retrieval_count signal only (no lexical overlap, no novelty heuristic)
  //   - default OFF, opt-in via the flag (no behaviour change without it)
  //   - 0.5 floor so non-salient entries stay reachable, never dropped
  // Reuses the existing retrieval_count column; no schema change.
  const salienceThresholdRaw = flags['salience-threshold'];
  if (salienceThresholdRaw !== undefined) {
    const T = Number(salienceThresholdRaw);
    if (!Number.isFinite(T) || T <= 0) {
      console.error(
        `Invalid --salience-threshold: "${salienceThresholdRaw}". Must be a positive number.`,
      );
      process.exit(1);
    }
    results = results
      .map((r) => {
        const count = r.entry.retrieval_count ?? 0;
        if (count >= T) return r;
        const mult = Math.max(0.5, count / T);
        const next = { ...r, score: r.score * mult };
        // A7 recall-trace: pineal salience (retrieval_count) down-weight. The
        // stage names the ACTUAL transform (retrieval_count, not goal-stack).
        // Only when --why.
        if (showWhy) {
          next.rerankTrace = [
            ...(r.rerankTrace ?? []),
            { stage: 'retrieval-count-downweight', multiplier: mult, scoreBefore: r.score, scoreAfter: next.score },
          ];
        }
        return next;
      })
      .sort((a, b) => b.score - a.score);
  }

  // --outcome filter: drop trace entries whose trace_outcome !== target.
  // Non-trace entries pass through unaffected (traces are the only layer with
  // a meaningful outcome; filtering non-traces by outcome would be incoherent).
  const outcomeFilter = flags['outcome'] !== undefined ? String(flags['outcome']).trim() : '';
  if (outcomeFilter) {
    const validOutcomes = ['success', 'failure', 'partial'];
    if (!validOutcomes.includes(outcomeFilter)) {
      console.error(`Invalid --outcome: "${outcomeFilter}". Must be one of: ${validOutcomes.join(', ')}.`);
      process.exit(1);
    }
    const beforeOutcomeFilter = results.length;
    results = results.filter((r) => {
      if (r.entry.layer !== Layer.Trace) return true;
      return r.entry.trace_outcome === outcomeFilter;
    });
    droppedPreRankCountCmd += beforeOutcomeFilter - results.length;
  }

  // --layer filter: strict, drops entries whose layer does not match.
  const layerFilter = flags['layer'] !== undefined ? String(flags['layer']).trim() : '';
  if (layerFilter) {
    const validLayers = Object.values(Layer) as string[];
    if (!validLayers.includes(layerFilter)) {
      console.error(`Invalid --layer: "${layerFilter}". Must be one of: ${validLayers.join(', ')}.`);
      process.exit(1);
    }
    const beforeLayerFilter = results.length;
    results = results.filter((r) => r.entry.layer === layerFilter);
    droppedPreRankCountCmd += beforeLayerFilter - results.length;
  }

  // v1.12.13 / C5 — WYSIATI dropped_by_budget counter (final limit cut).
  let droppedByBudgetCountCmd = 0;
  if (limit < results.length) {
    droppedByBudgetCountCmd = results.length - limit;
    results = results.slice(0, limit);
  }

  // v0.33 / J1 — CLI per-pipeline anchoring detector. Each pipeline (api.recall,
  // cmdRecall, MCP) computes its own AnchoringHint via the shared detectAnchoring
  // helper against its own top-1 + its own per-(tenant, session) ring buffer.
  // HIPPO_ANCHORING=off short-circuits BEFORE both the ring lookup and the
  // detect call so disabled tenants pay truly zero work. When sessionId is
  // absent we emit recall_anchor_skipped_no_session for J1-v2 telemetry.
  let cmdAnchoringHint: AnchoringHint | null = null;
  if (process.env.HIPPO_ANCHORING !== 'off') {
    if (sessionId) {
      const ringKey = buildSessionKey(tenantId, sessionId);
      const ring = getOrCreateRing(sessionRecallHistoryCli, ringKey);
      const queryHash = hashQueryText(query);
      const topId = results[0]?.entry.id ?? null;
      cmdAnchoringHint = detectAnchoring(snapshotRing(ring), queryHash, topId);
      // Append AFTER detect (snapshot was taken before). anchoredOn carries
      // the memoryId of any hint that fired, feeding the cooldown logic for
      // the NEXT cmdRecall on this session.
      appendRecall(ring, queryHash, topId, cmdAnchoringHint?.memoryId);
    } else {
      // Telemetry: caller had no sessionId so ring tracking is skipped.
      // Per the recall-audit convention at api.ts:854, use SHA-256/16
      // for prompt hashing (NOT hashQueryText which is FNV-1a 32-bit
      // for recall matching; brute-force trivial for low-entropy
      // queries). Codex round-1 P1 / round-2 P2 catch.
      emitCliAudit(hippoRoot, 'recall_anchor_skipped_no_session', undefined, {
        query_hash: createHash('sha256').update(query).digest('hex').slice(0, 16),
        query_length: query.length,
      });
    }
  }

  // v1.12.13 / C5 — Build suppressionSummary for cmdRecall pipeline. Surfaced
  // in --why text output and in the --json JSON output. cmdRecall does not
  // run the summarizeOverflow path (api.recall does) and does not currently
  // expose fresh-tail in the CLI, so those two counters are 0 here.
  // v0.33 / J1: suppressedByInterference is bumped by 1 when cmdAnchoringHint
  // fires with reason='memory_dominance' (the only reason that counts as
  // interference; query_repeat is a re-ask, not memory competition).
  const cmdSuppressedByInterference = cmdAnchoringHint?.reason === 'memory_dominance' ? 1 : 0;
  const cmdSuppressionSummary = api.buildSuppressionSummary({
    totalCandidates: totalCandidatesCountCmd,
    droppedPreRank: droppedPreRankCountCmd,
    droppedByBudget: droppedByBudgetCountCmd,
    summarySubstitutionsAdded: 0,
    freshTailAdded: 0,
    suppressedByInterference: cmdSuppressedByInterference,
  });

  // v0.33 / J1 — emit pipeline-local audit op when a hint fires (lockstep
  // with api.recall's audit pattern; each pipeline emits for its own hits).
  if (cmdAnchoringHint?.reason === 'memory_dominance') {
    emitCliAudit(hippoRoot, 'recall_anchor_detected_memory_dominance', cmdAnchoringHint.memoryId, {
      memory_id: cmdAnchoringHint.memoryId,
      query_count: cmdAnchoringHint.queryCount ?? null,
    });
  } else if (cmdAnchoringHint?.reason === 'query_repeat') {
    emitCliAudit(hippoRoot, 'recall_anchor_detected_query_repeat', cmdAnchoringHint.memoryId, {
      memory_id: cmdAnchoringHint.memoryId,
    });
  }

  // v1.13.x / J2 — CLI per-pipeline availability/recency-bias detector. Each
  // pipeline computes its own hint (this one against the CLI's returned top-K
  // and the full local+global candidate pool). Soft warning only. Gated by
  // HIPPO_AVAILABILITY=off, which short-circuits BEFORE the detect call so
  // disabled tenants pay zero work. Audit emission is pipeline-local, lockstep
  // with the anchoring emitCliAudit calls above. cmdAvailabilityHint is null on
  // the zero-result branch (topK < minReturned), so the splat is a no-op there.
  let cmdAvailabilityHint: AvailabilityHint | null = null;
  if (process.env.HIPPO_AVAILABILITY !== 'off') {
    cmdAvailabilityHint = detectAvailabilityBias({
      topK: results.map((r) => ({ id: r.entry.id, created: r.entry.created })),
      pool: [...localEntries, ...globalEntries].map((e) => ({ id: e.id, created: e.created })),
    });
    if (cmdAvailabilityHint) {
      emitCliAudit(hippoRoot, 'recall_availability_detected', undefined, {
        recent_fraction: cmdAvailabilityHint.recentFraction,
        older_passed_over: cmdAvailabilityHint.olderCandidatesPassedOver,
        returned_count: cmdAvailabilityHint.returnedCount,
      });
    }
  }

  // v0.32 / J3.2 — auto-injection of reference-class baserate when the
  // CLI query carries a forward-prediction phrase AND a class matches.
  // cmdRecall runs its own pipeline (doesn't go through api.recall for
  // the memory list), so it computes the hint here. The hint VALUE is
  // pipeline-invariant — same (hippoRoot, tenantId, query) inputs would
  // produce the same hint in api.recall — but the audit emission is
  // pipeline-local (one audit row per actual call, actor='cli' here).
  // computePlanningFallacyOutput short-circuits BEFORE the regex gate
  // when HIPPO_AUTODEBIAS=off so the no-match path is effectively free.
  // v1.13.4: switched to the richer Output type so the watching variant
  // (regex fired, no class matched OR tiebreak) can also surface.
  const cmdPlanningFallacyOutput = computePlanningFallacyOutput(
    hippoRoot,
    tenantId,
    query,
    { actor: 'cli' },
  );
  const cmdPlanningFallacyHint = cmdPlanningFallacyOutput.hint ?? null;
  const cmdPlanningFallacyWatching = cmdPlanningFallacyOutput.watching ?? null;

  // A5 audit: emit one 'recall' event per query, capturing the (truncated)
  // query text and the post-filter result count. Tenant resolved by emitCliAudit.
  // Emit before the early-empty return so zero-result recalls are still logged.
  // recall reads from BOTH local and global stores when both are initialized;
  // log against every participating store so the audit trail in either db
  // shows the read access (no false negatives across --global flows).
  const recallMetadata: Record<string, unknown> = {
    query: query.slice(0, 200),
    results: results.length,
  };
  emitCliAudit(hippoRoot, 'recall', undefined, recallMetadata);
  if (isInitialized(globalRoot) && globalRoot !== hippoRoot) {
    emitCliAudit(globalRoot, 'recall', undefined, recallMetadata);
  }

  // Continuity assembly (--continuity). Lives BEFORE the zero-result branch
  // so a no-match query with active continuity state still returns a useful
  // resume packet. Same three tenant-scoped store helpers as api.recall;
  // continuityTokens uses the same Math.ceil(len/4) rule as the search-path
  // estimateTokens() in src/search.ts.
  const includeContinuity = Boolean(flags['continuity']);
  let activeSnapshot: TaskSnapshot | null = null;
  let sessionHandoff: SessionHandoff | null = null;
  let recentSessionEvents: SessionEvent[] = [];
  let continuityTokens = 0;
  if (includeContinuity) {
    const rawSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
    const sessionId = rawSnapshot?.session_id ?? undefined;
    const rawHandoff = sessionId
      ? loadLatestHandoff(hippoRoot, tenantId, sessionId)
      : null;
    const rawEvents = sessionId
      ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: 5 })
      : [];
    // Mirror the api.recall default-deny rule for forward compat: when v1.2.0
    // continuity writers start setting scope, a no-scope caller must not see
    // private-channel-derived rows. Today scope is NULL on all continuity
    // rows so this is a no-op. Caller-supplied --scope bypasses the gate
    // (matches existing memory recall behavior).
    // Scope filter mirrors api.recall: exact match when scope is set, default-deny
    // on ANY `<source>:private:*` and 'unknown:legacy' otherwise. recallActiveScope
    // merges --scope flag and detectScope() so auto-detected source contexts get
    // matched. v1.2.1: generalized from slack-only to source-agnostic via
    // api.isPrivateScope so v1.3 GitHub (and future sources) cannot leak.
    const effectiveScope = recallActiveScope ?? '';
    const passesScopeFilter = (s: string | null): boolean => {
      if (effectiveScope) {
        return s === effectiveScope;
      }
      if (s === null) return true;
      if (api.isPrivateScope(s)) return false;
      // v1.7.2: read from RECALL_DEFAULT_DENY_SCOPES (single source of truth
      // shared with SQL + api.passesScopeFilterForRecall).
      if ((RECALL_DEFAULT_DENY_SCOPES as readonly string[]).includes(s)) return false;
      return true;
    };
    const rowScope = (
      r: { scope?: string | null } | null | undefined,
    ): string | null => r?.scope ?? null;
    activeSnapshot =
      rawSnapshot && passesScopeFilter(rowScope(rawSnapshot)) ? rawSnapshot : null;
    sessionHandoff =
      rawHandoff && passesScopeFilter(rowScope(rawHandoff)) ? rawHandoff : null;
    recentSessionEvents = rawEvents.filter((e) => passesScopeFilter(rowScope(e)));
    const tokenize = (s?: string | null): number =>
      s ? Math.ceil(s.length / 4) : 0;
    continuityTokens =
      tokenize(activeSnapshot?.task) +
      tokenize(activeSnapshot?.summary) +
      tokenize(activeSnapshot?.next_step) +
      tokenize(sessionHandoff?.summary) +
      tokenize(sessionHandoff?.nextAction) +
      (sessionHandoff?.artifacts ?? []).reduce((acc, a) => acc + tokenize(a), 0) +
      recentSessionEvents.reduce((acc, e) => acc + tokenize(e.content), 0);
  }
  const hasContinuity =
    activeSnapshot !== null
    || sessionHandoff !== null
    || recentSessionEvents.length > 0;

  if (results.length === 0) {
    if (asJson) {
      const out: Record<string, unknown> = {
        query,
        results: [],
        total: 0,
        suppressionSummary: cmdSuppressionSummary,
        // v0.32 / J3.2 — preserve planningFallacyHint on zero-result
        // recalls. Codex review round 1 catch: hint was previously only
        // included in the populated-results JSON branch, breaking parity
        // with HTTP/MCP which surface the hint regardless of memory
        // matches. A forward-claim query that finds no memories STILL
        // produces useful planning-fallacy debias when the class resolves.
        ...(cmdPlanningFallacyHint ? { planningFallacyHint: cmdPlanningFallacyHint } : {}),
        ...(cmdPlanningFallacyWatching ? { planningFallacyWatching: cmdPlanningFallacyWatching } : {}),
        ...(cmdAnchoringHint ? { anchoringHint: cmdAnchoringHint } : {}),
        ...(cmdAvailabilityHint ? { availabilityHint: cmdAvailabilityHint } : {}),
      };
      if (includeContinuity) {
        out.continuity = {
          activeSnapshot,
          sessionHandoff,
          recentSessionEvents,
        };
        out.continuityTokens = continuityTokens;
      }
      console.log(JSON.stringify(out));
      return;
    }
    // v0.33 / J1 — render anchoring hint above planning hint (anchoring
    // is the stronger cognitive-pull warning so it gets first position).
    if (cmdAnchoringHint) {
      console.log(
        `[anchored_on: ${cmdAnchoringHint.memoryId}] ${cmdAnchoringHint.summary}`,
      );
    }
    // v1.13.x / J2 — render availability/recency-bias hint below anchoring and
    // above the planning-fallacy hint. Soft warning; absent (env disabled or no
    // bias detected) is silent. Null on this zero-result branch anyway since
    // topK < minReturned, so this is effectively a no-op here; wired for parity.
    if (cmdAvailabilityHint) {
      console.log(
        `Availability bias (${cmdAvailabilityHint.recentCount}/${cmdAvailabilityHint.returnedCount} recent): ${cmdAvailabilityHint.summary}`,
      );
    }
    // v0.32 / J3.2 — render hint BEFORE the no-memories message so the
    // calling agent sees its track record even when the query missed
    // every memory. Same single-line shape + JSON.stringify-safe phrase
    // as the populated-results path below.
    if (cmdPlanningFallacyHint) {
      const safePhrase = JSON.stringify(cmdPlanningFallacyHint.detectedPhrase);
      console.log(
        `Planning fallacy hint (class: ${cmdPlanningFallacyHint.classTag}): ${cmdPlanningFallacyHint.baserateSummary} [detected: ${safePhrase}]`,
      );
      console.log();
    } else if (cmdPlanningFallacyWatching) {
      // v1.13.4: render the watching variant when the regex matched but no
      // baserate could be produced. Suggestion text directs the user to
      // tag a prediction class so future queries can produce a baserate.
      const safePhrase = JSON.stringify(cmdPlanningFallacyWatching.detectedPhrase);
      console.log(
        `Planning fallacy: watching this query (reason: ${cmdPlanningFallacyWatching.reason}). ${cmdPlanningFallacyWatching.suggestion} [detected: ${safePhrase}]`,
      );
      console.log();
    }
    if (hasContinuity) {
      // Print continuity even when no memories matched. The resume packet
      // is the whole point of `--continuity` and must not be dropped here.
      if (activeSnapshot) printActiveTaskSnapshot(activeSnapshot);
      if (sessionHandoff) printHandoff(sessionHandoff);
      if (recentSessionEvents.length > 0) printSessionEvents(recentSessionEvents);
      console.log(`(no memories matched "${query}")`);
      return;
    }
    console.log('No memories found for:', query);
    return;
  }

  // Update retrieval metadata and persist
  const updated = markRetrieved(results.map((r) => r.entry));
  const localIndex = loadIndex(hippoRoot);
  for (const u of updated) {
    const targetRoot = localIndex.entries[u.id] ? hippoRoot : (isInitialized(globalRoot) ? globalRoot : hippoRoot);
    writeEntry(targetRoot, u);
  }

  // Track last retrieval IDs for outcome command
  localIndex.last_retrieval_ids = updated.map((u) => u.id);
  saveIndex(hippoRoot, localIndex);

  updateStats(hippoRoot, { recalled: results.length });

  if (asJson) {
    const output = results.map((r) => {
      const isGlobal = isInitialized(globalRoot) && !localIndex.entries[r.entry.id];
      const base: Record<string, unknown> = {
        id: r.entry.id,
        score: r.score,
        strength: r.entry.strength,
        tokens: r.tokens,
        tags: r.entry.tags,
        content: r.entry.content,
        layer: r.entry.layer,
      };
      if (r.entry.layer === Layer.Trace) {
        base.trace_outcome = r.entry.trace_outcome;
      }
      if (r.entry.superseded_by) {
        base.superseded = true;
        base.superseded_by = r.entry.superseded_by;
      }
      if (r.graphVia) {
        base.graphVia = r.graphVia;
      }
      if (showWhy) {
        const explanation = explainMatch(query, r);
        base.confidence = resolveConfidence(r.entry);
        base.source = isGlobal ? 'global' : 'local';
        base.reason = explanation.reason;
        base.bm25 = r.bm25;
        base.cosine = r.cosine;
        if (explanation.envelope) {
          base.envelope = explanation.envelope;
        }
        // A7 recall-trace: emit the ordered lifecycle re-ranking steps.
        if (r.rerankTrace && r.rerankTrace.length > 0) {
          base.rerankTrace = r.rerankTrace;
        }
      }
      return base;
    });
    const jsonOut: Record<string, unknown> = {
      query,
      budget,
      results: output,
      total: output.length,
      suppressionSummary: cmdSuppressionSummary,
      ...(cmdPlanningFallacyHint ? { planningFallacyHint: cmdPlanningFallacyHint } : {}),
      ...(cmdPlanningFallacyWatching ? { planningFallacyWatching: cmdPlanningFallacyWatching } : {}),
      ...(cmdAnchoringHint ? { anchoringHint: cmdAnchoringHint } : {}),
      ...(cmdAvailabilityHint ? { availabilityHint: cmdAvailabilityHint } : {}),
    };
    if (includeContinuity) {
      jsonOut.continuity = {
        activeSnapshot,
        sessionHandoff,
        recentSessionEvents,
      };
      jsonOut.continuityTokens = continuityTokens;
    }
    console.log(JSON.stringify(jsonOut));
    return;
  }

  const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);
  if (includeContinuity && hasContinuity) {
    if (activeSnapshot) printActiveTaskSnapshot(activeSnapshot);
    if (sessionHandoff) printHandoff(sessionHandoff);
    if (recentSessionEvents.length > 0) printSessionEvents(recentSessionEvents);
  }
  // v0.33 / J1 — render anchoring hint above planning-fallacy hint
  // (anchoring is the stronger cognitive-pull warning so it gets first
  // position). Hint absent (env disabled, no sessionId, or no R1/R2)
  // is silent.
  if (cmdAnchoringHint) {
    console.log(
      `[anchored_on: ${cmdAnchoringHint.memoryId}] ${cmdAnchoringHint.summary}`,
    );
    console.log();
  }
  // v1.13.x / J2 — render availability/recency-bias hint below anchoring and
  // above the planning-fallacy hint. Soft warning; absent (env disabled or no
  // bias detected) is silent.
  if (cmdAvailabilityHint) {
    console.log(
      `Availability bias (${cmdAvailabilityHint.recentCount}/${cmdAvailabilityHint.returnedCount} recent): ${cmdAvailabilityHint.summary}`,
    );
    console.log();
  }
  // v0.32 / J3.2 — render planning-fallacy hint ABOVE the result list so
  // the agent sees its track record before scrolling. Hint absent (env
  // disabled or no forward-claim match) is silent. detectedPhrase is
  // sanitised against control chars and ASCII quotes via JSON.stringify
  // to head off rendering ambiguity when a regex match contains quotes
  // or parens (plan-eng-critic round 2 LOW).
  if (cmdPlanningFallacyHint) {
    const safePhrase = JSON.stringify(cmdPlanningFallacyHint.detectedPhrase);
    console.log(
      `Planning fallacy hint (class: ${cmdPlanningFallacyHint.classTag}): ${cmdPlanningFallacyHint.baserateSummary} [detected: ${safePhrase}]`,
    );
    console.log();
  } else if (cmdPlanningFallacyWatching) {
    // v1.13.4: render the watching variant when the regex matched but no
    // baserate could be produced (no_class_match / tiebreak). Suggestion
    // text directs the user toward an action that would unblock the
    // hint next time (typically: tag a prediction class).
    const safePhrase = JSON.stringify(cmdPlanningFallacyWatching.detectedPhrase);
    console.log(
      `Planning fallacy: watching this query (reason: ${cmdPlanningFallacyWatching.reason}). ${cmdPlanningFallacyWatching.suggestion} [detected: ${safePhrase}]`,
    );
    console.log();
  }
  // v1.13.3 / C5 follow-up — Cutoff line ABOVE the result list (was a
  // "WYSIATI:" line BELOW the result list in v1.12.13-v1.13.2). Dogfood
  // proof at docs/dogfood/2026-05-27-track-j-warnings.md: a fresh sub-agent
  // reading the v1.13.2 bottom-placed line ignored it entirely and
  // summarised the visible memories as if the dropped pool didn't exist
  // (the exact WYSIATI failure mode C5 is supposed to flag). Top placement
  // + plain English ("Cutoff:" not "WYSIATI:") closes the read gap.
  if (showWhy) {
    const s = cmdSuppressionSummary;
    const clauses: string[] = [];
    if (s.droppedByBudget > 0) clauses.push(`${s.droppedByBudget} dropped to fit limit`);
    if (s.droppedPreRank > 0) clauses.push(`${s.droppedPreRank} filtered pre-rank`);
    if (s.summarySubstitutionsAdded > 0) clauses.push(`${s.summarySubstitutionsAdded} summary substitutions added`);
    if (s.freshTailAdded > 0) clauses.push(`${s.freshTailAdded} fresh-tail added`);
    if (s.suppressedByInterference > 0) clauses.push(`${s.suppressedByInterference} suppressed by interference`);
    if (clauses.length > 0) {
      console.log(`Cutoff: showing ${results.length} of ${s.totalCandidates} candidates; ${clauses.join('; ')}.`);
      console.log();
    }
  }
  console.log(`Found ${results.length} memories (${totalTokens} tokens) for: "${query}"\n`);

  for (const r of results) {
    const e = r.entry;
    const conf = resolveConfidence(e);
    const confLabel = conf === 'stale' || conf === 'inferred' ? `[${conf}] \u26A0\uFE0F` : `[${conf}]`;
    const strengthBar = '\u2588'.repeat(Math.round(e.strength * 10)) + '\u2591'.repeat(10 - Math.round(e.strength * 10));
    const isGlobal = isInitialized(globalRoot) && !localIndex.entries[e.id];
    const globalMark = isGlobal ? ' [global]' : '';
    const supersededMark = e.superseded_by ? ' [superseded]' : '';
    const graphMark = r.graphVia ? ` [graph: ${r.graphVia.hops}hop ${r.graphVia.relType}]` : '';
    const sourceMark = isGlobal ? ' [global]' : ' [local]';
    console.log(`--- ${e.id} [${e.layer}] ${confLabel}${globalMark}${supersededMark}${graphMark} score=${fmt(r.score, 3)} strength=${fmt(e.strength)}`);
    console.log(`    [${strengthBar}] tags: ${e.tags.join(', ') || 'none'} | retrieved: ${e.retrieval_count}x`);
    if (showWhy) {
      const explanation = explainMatch(query, r);
      console.log(`    source:${sourceMark} | layer: [${e.layer}] | confidence: [${conf}]`);
      console.log(`    reason: ${explanation.reason}`);
      if (explanation.envelope) {
        const env = explanation.envelope;
        console.log(`    kind: ${env.kind}`);
        if (env.scope) console.log(`    scope: ${env.scope}`);
        if (env.owner) console.log(`    owner: ${env.owner}`);
        if (env.artifact_ref) console.log(`    artifact_ref: ${env.artifact_ref}`);
        if (env.session_id) console.log(`    session_id: ${env.session_id}`);
        console.log(`    confidence: ${env.confidence}`);
      }
      // A7 recall-trace: render the ordered lifecycle re-ranking chain, e.g.
      // "ranking: base 0.420 -> interference x0.3 -> 0.126 -> goal-boost x1.5 -> 0.189".
      if (r.rerankTrace && r.rerankTrace.length > 0) {
        const parts = [`base ${fmt(r.rerankTrace[0].scoreBefore, 3)}`];
        for (const step of r.rerankTrace) {
          const mult = step.multiplier !== undefined ? ` x${fmt(step.multiplier, 2)}` : '';
          parts.push(`${step.stage}${mult}`);
          parts.push(fmt(step.scoreAfter, 3));
        }
        console.log(`    ranking: ${parts.join(' -> ')}`);
      }
    }
    console.log();
    console.log(e.content);
    console.log();
  }

  // v1.12.13 / C5 -> v1.13.3 follow-up: the WYSIATI bottom block was
  // moved above the result list (see comment near the Cutoff render
  // above). Function ends here.
}

async function cmdExplain(
  hippoRoot: string,
  query: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseInt(String(flags['budget'] ?? '4000'), 10);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const forcePhysics = Boolean(flags['physics']);
  const forceClassic = Boolean(flags['classic']);
  const explainIncludeSuperseded = Boolean(flags['include-superseded']);
  const explainAsOf = typeof flags['as-of'] === 'string' ? flags['as-of'] : undefined;
  if (explainAsOf !== undefined && Number.isNaN(new Date(explainAsOf).getTime())) {
    console.error(`Error: --as-of value "${explainAsOf}" is not a valid ISO date (e.g. 2026-04-22 or 2026-04-22T12:00:00Z).`);
    process.exit(1);
  }
  const globalRoot = getGlobalRoot();

  // A5: scope explain results to the active tenant.
  const tenantId = resolveTenantId({});
  let explainLocalEntries = loadSearchEntries(hippoRoot, query, undefined, tenantId);
  let explainGlobalEntries = isInitialized(globalRoot) ? loadSearchEntries(globalRoot, query, undefined, tenantId) : [];

  // Bi-temporal filtering
  if (explainAsOf) {
    const filterAsOfExplain = (entries: MemoryEntry[]) => {
      const asOfDate = new Date(explainAsOf);
      const successorValidFrom = new Map<string, string>();
      for (const e of entries) {
        if (e.superseded_by) {
          const successor = entries.find(s => s.id === e.superseded_by);
          if (successor) successorValidFrom.set(e.id, successor.valid_from);
        }
      }
      return entries.filter(e => {
        if (new Date(e.valid_from) > asOfDate) return false;
        if (!e.superseded_by) return true;
        const succVf = successorValidFrom.get(e.id);
        return succVf ? new Date(succVf) > asOfDate : true;
      });
    };
    explainLocalEntries = filterAsOfExplain(explainLocalEntries);
    explainGlobalEntries = filterAsOfExplain(explainGlobalEntries);
  } else if (!explainIncludeSuperseded) {
    explainLocalEntries = explainLocalEntries.filter(e => !e.superseded_by);
    explainGlobalEntries = explainGlobalEntries.filter(e => !e.superseded_by);
  }

  const hasGlobal = explainGlobalEntries.length > 0;
  const config = loadConfig(hippoRoot);
  const usePhysics = forcePhysics
    || (!forceClassic && config.physics.enabled !== false);

  const noMmr = Boolean(flags['no-mmr']);
  const mmrLambda = flags['mmr-lambda'] !== undefined
    ? parseFloat(String(flags['mmr-lambda']))
    : config.mmr.lambda;
  const mmrEnabled = !noMmr && config.mmr.enabled;
  const localBump = flags['equal-sources']
    ? 1.0
    : flags['local-bump'] !== undefined
      ? parseFloat(String(flags['local-bump']))
      : config.search.localBump;
  const explainExplicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const explainActiveScope = explainExplicitScope || detectScope();

  let results;
  let modeUsed: 'physics' | 'searchBothHybrid' | 'hybrid';
  if (usePhysics && !hasGlobal) {
    results = await physicsSearch(query, explainLocalEntries, {
      budget,
      hippoRoot,
      physicsConfig: config.physics,
      explain: true,
      scope: explainActiveScope,
    });
    modeUsed = 'physics';
  } else if (hasGlobal) {
    results = await searchBothHybrid(query, hippoRoot, globalRoot, {
      budget, explain: true, mmr: mmrEnabled, mmrLambda, localBump, scope: explainActiveScope,
      includeSuperseded: explainIncludeSuperseded, asOf: explainAsOf, tenantId,
    });
    modeUsed = 'searchBothHybrid';
  } else {
    results = await hybridSearch(query, explainLocalEntries, {
      budget, hippoRoot, explain: true, mmr: mmrEnabled, mmrLambda, scope: explainActiveScope,
      includeSuperseded: explainIncludeSuperseded, asOf: explainAsOf,
    });
    modeUsed = 'hybrid';
  }

  if (limit < results.length) {
    results = results.slice(0, limit);
  }

  const candidates = explainLocalEntries.length + explainGlobalEntries.length;

  if (asJson) {
    const output = results.map((r, rank) => ({
      rank: rank + 1,
      id: r.entry.id,
      layer: r.entry.layer,
      confidence: resolveConfidence(r.entry),
      score: r.score,
      tokens: r.tokens,
      tags: r.entry.tags,
      content: r.entry.content,
      breakdown: r.breakdown,
    }));
    console.log(JSON.stringify({
      query,
      mode: modeUsed,
      candidates,
      returned: output.length,
      results: output,
    }));
    return;
  }

  if (results.length === 0) {
    console.log(`No memories matched "${query}" (scanned ${candidates}).`);
    return;
  }

  console.log(`Query: "${query}"`);
  console.log(`Mode:  ${modeUsed}   candidates: ${candidates}   returned: ${results.length}`);
  console.log();
  console.log('Rank  Score   Strength  Age    Layer      ID                Preview');
  console.log('----- ------- --------- ------ ---------- ----------------- ---------------------------------');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const b = r.breakdown;
    const preview = r.entry.content.replace(/\s+/g, ' ').slice(0, 48);
    const ageStr = b ? `${b.ageDays}d` : '?';
    console.log(
      `${String(i + 1).padEnd(5)} ${fmt(r.score, 3).padEnd(7)} ${fmt(r.entry.strength).padEnd(9)} ${ageStr.padEnd(6)} ${r.entry.layer.padEnd(10)} ${r.entry.id.padEnd(17)} ${preview}`,
    );
  }
  console.log();

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const b = r.breakdown;
    console.log(`[${i + 1}] ${r.entry.id}   composite=${fmt(r.score, 4)}`);
    if (!b) {
      console.log('    (no breakdown available)');
      console.log();
      continue;
    }
    if (b.mode === 'physics') {
      console.log(`    mode:      physics-gravity`);
      console.log(`    cosine:    ${fmt(b.cosine, 3)}  (pre-amp baseline)`);
      console.log(`    final:     ${fmt(b.final, 4)}  (post-amp, from physics scorer)`);
    } else {
      const matched = b.matchedTerms.length > 0 ? b.matchedTerms.join(', ') : '(none)';
      console.log(`    mode:      ${b.mode}${b.mode === 'hybrid-no-vec' ? '  (no cached doc vector — run `hippo embed`)' : ''}`);
      console.log(`    BM25:      raw=${fmt(r.bm25, 3)}  normalized=${fmt(b.normBm25, 3)}  weight=${fmt(b.bm25Weight, 2)}  matched=[${matched}]`);
      console.log(`    embedding: cosine=${fmt(b.cosine, 3)}  weight=${fmt(b.embeddingWeight, 2)}`);
      console.log(`    base:      ${fmt(b.bm25Weight, 2)}*${fmt(b.normBm25, 3)} + ${fmt(b.embeddingWeight, 2)}*${fmt(b.cosine, 3)} = ${fmt(b.base, 4)}`);
      console.log(`    strength:  x${fmt(b.strengthMultiplier, 3)}  (strength=${fmt(r.entry.strength, 3)})`);
      console.log(`    recency:   x${fmt(b.recencyMultiplier, 3)}  (age=${b.ageDays}d)`);
      if (b.decisionBoost !== 1) console.log(`    decision:  x${fmt(b.decisionBoost, 2)}  (tagged 'decision')`);
      if (b.scopeBoost !== 1) console.log(`    scope:     x${fmt(b.scopeBoost, 2)}  (scope tag ${b.scopeBoost > 1 ? 'match' : 'mismatch'})`);
      if (b.pathBoost !== 1) console.log(`    path:      x${fmt(b.pathBoost, 3)}  (cwd path tag overlap)`);
      if (b.sourceBump !== 1) console.log(`    source:    x${fmt(b.sourceBump, 2)}  (local priority bump over global)`);
      if (b.outcomeBoost !== 1) console.log(`    outcome:   x${fmt(b.outcomeBoost, 3)}  (user feedback: pos-neg = ${(r.entry.outcome_positive ?? 0) - (r.entry.outcome_negative ?? 0)})`);
      if (b.preMmrRank !== undefined && b.postMmrRank !== undefined && b.preMmrRank !== b.postMmrRank) {
        const arrow = b.postMmrRank < b.preMmrRank ? 'up' : 'down';
        console.log(`    mmr:       rank ${b.preMmrRank} -> ${b.postMmrRank}  (diversity ${arrow})`);
      }
      console.log(`    final:     ${fmt(b.final, 4)}`);
    }
    console.log();
  }

  console.log('Note: explain does not mark memories as retrieved (read-only).');
}

async function cmdEval(
  hippoRoot: string,
  corpusPath: string | null,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const asJson = Boolean(flags['json']);
  const minMrr = flags['min-mrr'] !== undefined ? parseFloat(String(flags['min-mrr'])) : null;
  const showCases = Boolean(flags['show-cases']);
  const comparePath = flags['compare'] ? String(flags['compare']) : null;
  const noMmr = Boolean(flags['no-mmr']);
  const mmrLambda = flags['mmr-lambda'] !== undefined ? parseFloat(String(flags['mmr-lambda'])) : undefined;
  const embeddingWeight = flags['embedding-weight'] !== undefined ? parseFloat(String(flags['embedding-weight'])) : undefined;

  // Suite mode doesn't need an initialized store
  if (flags['suite']) {
    // handled below after bootstrap check
  } else {
    requireInit(hippoRoot);
  }

  const entries = flags['suite'] ? [] : loadAllEntries(hippoRoot);

  // Bootstrap mode: emit a synthetic corpus and exit.
  if (flags['bootstrap']) {
    const outPath = flags['out'] ? String(flags['out']) : null;
    const max = flags['max-cases'] !== undefined ? parseInt(String(flags['max-cases']), 10) : 50;
    const corpus = bootstrapCorpus(entries, max);
    const payload = JSON.stringify({ cases: corpus }, null, 2);
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, payload, 'utf8');
      console.log(`Wrote ${corpus.length} bootstrap cases to ${outPath}`);
    } else {
      console.log(payload);
    }
    return;
  }

  // Suite mode: run built-in feature eval (no corpus file needed, no init needed)
  if (flags['suite']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', 'package.json'), 'utf8'));
    const version = pkg.version || 'unknown';

    const baselinePath = flags['baseline'] ? String(flags['baseline']) : path.join(hippoRoot, 'eval-baseline.json');
    let baseline: EvalBaseline | undefined;
    if (fs.existsSync(baselinePath)) {
      try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch {}
    }

    const result = await runFeatureEval(version);

    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatResult(result, baseline));
    }

    if (flags['save-baseline']) {
      const newBaseline = resultToBaseline(result);
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2), 'utf8');
      console.log(`\nBaseline saved to ${baselinePath}`);
    }

    if (baseline) {
      const report = detectRegressions(baseline, result);
      if (report.verdict === 'REGRESSION' && minMrr === null) {
        process.exit(1);
      }
    }

    return;
  }

  if (!corpusPath) {
    console.error('Usage: hippo eval <corpus.json>  OR  hippo eval --suite [--save-baseline]  OR  hippo eval --bootstrap');
    process.exit(1);
  }

  if (!fs.existsSync(corpusPath)) {
    console.error(`Corpus file not found: ${corpusPath}`);
    process.exit(1);
  }

  let cases: EvalCase[];
  try {
    const raw = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    cases = Array.isArray(raw) ? raw : raw.cases;
    if (!Array.isArray(cases)) throw new Error('Corpus JSON must be an array or { cases: [...] }');
  } catch (err) {
    console.error(`Failed to read corpus: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const globalRoot = getGlobalRoot();
  const localBump = flags['equal-sources']
    ? 1.0
    : flags['local-bump'] !== undefined
      ? parseFloat(String(flags['local-bump']))
      : loadConfig(hippoRoot).search.localBump;

  const summary = await runEval(cases, entries, {
    hippoRoot,
    globalRoot,
    mmr: !noMmr,
    mmrLambda,
    embeddingWeight,
    localBump,
  });

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Eval: ${summary.cases.length} cases, ${summary.durationMs}ms`);
    console.log();
    console.log(`MRR:          ${fmt(summary.meanMrr, 4)}`);
    console.log(`Recall@5:     ${fmt(summary.meanRecallAt5, 4)}`);
    console.log(`Recall@10:    ${fmt(summary.meanRecallAt10, 4)}`);
    console.log(`NDCG@10:      ${fmt(summary.meanNdcgAt10, 4)}`);

    if (showCases) {
      console.log();
      console.log('Case details:');
      for (const c of summary.cases) {
        const exp = c.case.expectedIds.length;
        const expectedSet = new Set(c.case.expectedIds);
        const hitTop10 = c.returnedIds.slice(0, 10).filter((id) => expectedSet.has(id));
        const missed = c.case.expectedIds.filter((id) => !c.returnedIds.slice(0, 10).includes(id));
        console.log();
        console.log(`[${c.case.id}] R@10=${fmt(c.recallAt10, 2)}  MRR=${fmt(c.mrr, 2)}  expected=${exp}  hit=${hitTop10.length}`);
        console.log(`  query: ${c.case.query}`);
        console.log(`  top 3: ${c.returnedIds.slice(0, 3).join(', ') || '(none)'}`);
        if (missed.length > 0) {
          const shown = missed.slice(0, 4);
          const more = missed.length > shown.length ? ` +${missed.length - shown.length} more` : '';
          console.log(`  missed: ${shown.join(', ')}${more}`);
        }
      }
    }

    console.log();
    const failing = summary.cases.filter((c) => c.mrr === 0);
    if (failing.length > 0) {
      console.log(`${failing.length} case(s) returned zero relevant results:`);
      for (const f of failing.slice(0, 10)) {
        console.log(`  [${f.case.id}] "${f.case.query.slice(0, 60)}"`);
      }
      if (failing.length > 10) console.log(`  ...and ${failing.length - 10} more`);
    }
  }

  if (minMrr !== null && summary.meanMrr < minMrr) {
    console.error(`MRR ${fmt(summary.meanMrr, 4)} below threshold ${minMrr}`);
    process.exit(1);
  }

  if (comparePath) {
    if (!fs.existsSync(comparePath)) {
      console.error(`Baseline file not found: ${comparePath}`);
      process.exit(1);
    }
    let baseline: EvalSummary;
    try {
      baseline = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    } catch (err) {
      console.error(`Failed to parse baseline: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    const cmp = compareSummaries(baseline, summary);

    if (asJson) {
      // The main JSON output already emitted; append comparison to stderr so
      // both can be captured independently.
      console.error(JSON.stringify({ compare: cmp }, null, 2));
    } else {
      console.log();
      console.log('Compare vs baseline:');
      const sign = (d: number): string => (d >= 0 ? '+' : '') + fmt(d, 4);
      console.log(`  MRR:        ${sign(cmp.aggregate.mrr)}`);
      console.log(`  Recall@5:   ${sign(cmp.aggregate.recallAt5)}`);
      console.log(`  Recall@10:  ${sign(cmp.aggregate.recallAt10)}`);
      console.log(`  NDCG@10:    ${sign(cmp.aggregate.ndcgAt10)}`);
      console.log();
      console.log(`  improved: ${cmp.improved.length}   regressed: ${cmp.regressed.length}   unchanged: ${cmp.unchanged}`);
      if (cmp.onlyInBaseline.length > 0) console.log(`  only in baseline: ${cmp.onlyInBaseline.length}`);
      if (cmp.onlyInCurrent.length > 0) console.log(`  only in current:  ${cmp.onlyInCurrent.length}`);

      const showPerCase = cmp.improved.length + cmp.regressed.length > 0;
      if (showPerCase) {
        for (const d of cmp.improved.slice(0, 5)) {
          const delta = d.ndcgAfter - d.ndcgBefore;
          console.log(`  + [${d.id}] NDCG ${fmt(d.ndcgBefore, 2)} -> ${fmt(d.ndcgAfter, 2)} (+${fmt(delta, 3)})`);
        }
        for (const d of cmp.regressed.slice(0, 5)) {
          const delta = d.ndcgAfter - d.ndcgBefore;
          console.log(`  - [${d.id}] NDCG ${fmt(d.ndcgBefore, 2)} -> ${fmt(d.ndcgAfter, 2)} (${fmt(delta, 3)})`);
        }
      }
    }
  }
}

function cmdTraceRecord(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);

  const task = String(flags['task'] ?? '').trim();
  const stepsJson = String(flags['steps'] ?? '').trim();
  const outcome = String(flags['outcome'] ?? '').trim();
  const validOutcomes = ['success', 'failure', 'partial'];

  if (!task || !stepsJson || !outcome) {
    console.error('Usage: hippo trace record --task <t> --steps <json> --outcome <success|failure|partial> [--session <id>] [--tag <t>]');
    process.exit(1);
  }
  if (!validOutcomes.includes(outcome)) {
    console.error(`Invalid outcome: "${outcome}". Must be one of: ${validOutcomes.join(', ')}.`);
    process.exit(1);
  }

  let steps;
  try {
    steps = parseSteps(stepsJson);
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }

  const sessionId = String(flags['session'] ?? '').trim() || null;
  const rawTags = flags['tag'];
  const tags = Array.isArray(rawTags)
    ? rawTags.map((t) => String(t))
    : rawTags !== undefined
      ? [String(rawTags)]
      : [];

  const content = renderTraceContent({
    task,
    steps,
    outcome: outcome as 'success' | 'failure' | 'partial',
  });

  const entry = createMemory(content, {
    layer: Layer.Trace,
    tags,
    source: String(flags['source'] ?? 'cli'),
    trace_outcome: outcome as 'success' | 'failure' | 'partial',
    source_session_id: sessionId,
  });

  writeEntry(hippoRoot, entry);

  console.log(`Recorded trace ${entry.id} (outcome=${outcome}, ${steps.length} steps)`);
}

function cmdTrace(
  hippoRoot: string,
  id: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);
  const asJson = Boolean(flags['json']);
  const tenantId = resolveTenantId({});

  // Look in local store first, then global.
  let entry = readEntry(hippoRoot, id, tenantId);
  let sourceLabel: 'local' | 'global' = 'local';
  const globalRoot = getGlobalRoot();
  if (!entry && isInitialized(globalRoot)) {
    entry = readEntry(globalRoot, id, tenantId);
    sourceLabel = 'global';
  }
  if (!entry) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }

  const now = new Date();
  const strength = calculateStrength(entry, now);
  const halfLife = deriveHalfLife(7, entry);
  const rewardFactor = calculateRewardFactor(entry);
  const effHalfLife = halfLife * rewardFactor;
  const createdMs = new Date(entry.created).getTime();
  const ageDays = (now.getTime() - createdMs) / 86_400_000;
  const lastMs = new Date(entry.last_retrieved).getTime();
  const sinceLast = (now.getTime() - lastMs) / 86_400_000;
  const conf = resolveConfidence(entry, now);

  // Projected strength: same decay curve, just push `now` out.
  const projectedAt = (days: number): number =>
    calculateStrength(entry, new Date(now.getTime() + days * 86_400_000));

  // Parents (consolidation lineage) — schema v9 field.
  const parents = Array.isArray(entry.parents) ? entry.parents : [];
  const parentPreviews = parents.map((pid) => {
    const p = readEntry(hippoRoot, pid, tenantId) ?? (isInitialized(globalRoot) ? readEntry(globalRoot, pid, tenantId) : null);
    return { id: pid, content: p ? p.content.replace(/\s+/g, ' ').slice(0, 70) : '(not found)' };
  });

  // Open conflicts involving this memory.
  const allConflicts = [
    ...listMemoryConflicts(hippoRoot, 'open', tenantId),
    ...(isInitialized(globalRoot) ? listMemoryConflicts(globalRoot, 'open', tenantId) : []),
  ];
  const myConflicts = allConflicts.filter((c) => c.memory_a_id === id || c.memory_b_id === id);

  if (asJson) {
    console.log(JSON.stringify({
      id: entry.id,
      source: sourceLabel,
      layer: entry.layer,
      confidence: conf,
      pinned: entry.pinned,
      starred: entry.starred,
      tags: entry.tags,
      content: entry.content,
      created: entry.created,
      age_days: ageDays,
      last_retrieved: entry.last_retrieved,
      days_since_last_retrieval: sinceLast,
      retrieval_count: entry.retrieval_count,
      strength_now: strength,
      half_life_days: halfLife,
      reward_factor: rewardFactor,
      effective_half_life_days: effHalfLife,
      projected_strength_30d: projectedAt(30),
      projected_strength_90d: projectedAt(90),
      outcome_positive: entry.outcome_positive,
      outcome_negative: entry.outcome_negative,
      parents: parentPreviews,
      open_conflicts: myConflicts,
    }, null, 2));
    return;
  }

  console.log(`Memory: ${entry.id}  [${sourceLabel}]`);
  console.log('='.repeat(50));
  console.log(`Content:   ${entry.content.replace(/\s+/g, ' ').slice(0, 160)}${entry.content.length > 160 ? '...' : ''}`);
  console.log(`Layer:     ${entry.layer.padEnd(10)} Confidence: ${conf.padEnd(10)} Pinned: ${entry.pinned ? 'yes' : 'no'}${entry.starred ? '  Starred: yes' : ''}`);
  console.log(`Tags:      ${entry.tags.join(', ') || '(none)'}`);
  console.log(`Created:   ${entry.created}  (${fmt(ageDays, 1)} days ago)`);
  console.log();
  console.log(`Strength trajectory:`);
  console.log(`  now:        ${fmt(strength, 3)}`);
  console.log(`  in 30 days: ${fmt(projectedAt(30), 3)}`);
  console.log(`  in 90 days: ${fmt(projectedAt(90), 3)}`);
  console.log(`  half-life:  ${fmt(halfLife, 1)}d (base) x ${fmt(rewardFactor, 2)} reward = ${fmt(effHalfLife, 1)}d effective`);
  console.log();
  console.log(`Retrieval:`);
  console.log(`  count:      ${entry.retrieval_count}`);
  console.log(`  last:       ${entry.last_retrieved}  (${fmt(sinceLast, 1)} days ago)`);
  console.log();
  console.log(`Outcomes:   +${entry.outcome_positive} / -${entry.outcome_negative}`);
  if (parentPreviews.length > 0) {
    console.log();
    console.log(`Parents (consolidation lineage):`);
    for (const p of parentPreviews) {
      console.log(`  - ${p.id}: ${p.content}`);
    }
  }
  if (myConflicts.length > 0) {
    console.log();
    console.log(`Open conflicts: ${myConflicts.length}`);
    for (const c of myConflicts) {
      const other = c.memory_a_id === id ? c.memory_b_id : c.memory_a_id;
      console.log(`  - with ${other}: ${c.reason} (score=${fmt(c.score, 2)})`);
    }
  }
}

async function cmdRefine(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): Promise<void> {
  requireInit(hippoRoot);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('hippo refine needs ANTHROPIC_API_KEY in the environment.');
    process.exit(1);
  }

  const dryRun = Boolean(flags['dry-run']);
  const all = Boolean(flags['all']);
  const limit = flags['limit'] !== undefined ? parseInt(String(flags['limit']), 10) : undefined;
  const model = flags['model'] ? String(flags['model']) : undefined;
  const asJson = Boolean(flags['json']);

  const result = await refineStore(hippoRoot, {
    apiKey,
    model,
    limit,
    dryRun,
    all,
    tenantId: resolveTenantId({}),
  });

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Scanned:  ${result.scanned} consolidated semantic memories`);
  console.log(`Refined:  ${result.refined}${dryRun ? '  (dry-run — no writes)' : ''}`);
  console.log(`Skipped:  ${result.skipped}`);
  console.log(`Failed:   ${result.failed}`);
  if (result.failed > 0) {
    console.log('\nFailures:');
    for (const d of result.details.filter((x) => x.status === 'failed').slice(0, 5)) {
      console.log(`  ${d.id}: ${d.reason}`);
    }
  }
}

/**
 * Scan for Claude Code MEMORY.md files and import new entries into hippo.
 * Looks in ~/.claude/projects/<project>/memory/ for .md files with YAML frontmatter.
 */
function learnFromMemoryMd(hippoRoot: string): number {
  const home = os.homedir();
  const memoryDirs: string[] = [];

  // Claude Code project memories
  const claudeProjectsDir = path.join(home, '.claude', 'projects');
  if (fs.existsSync(claudeProjectsDir)) {
    try {
      for (const project of fs.readdirSync(claudeProjectsDir)) {
        const memDir = path.join(claudeProjectsDir, project, 'memory');
        if (fs.existsSync(memDir)) memoryDirs.push(memDir);
      }
    } catch { /* permission denied */ }
  }

  if (memoryDirs.length === 0) return 0;

  const existing = loadAllEntries(hippoRoot);
  let imported = 0;

  for (const memDir of memoryDirs) {
    try {
      const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const file of files) {
        const raw = fs.readFileSync(path.join(memDir, file), 'utf8');

        // Parse YAML frontmatter
        const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (!fmMatch) continue;

        const body = fmMatch[2].trim();
        if (!body || body.length < 10) continue;

        // Truncate to reasonable size
        const content = body.length > 1500 ? body.slice(0, 1500) + ' [truncated]' : body;

        // Dedup: check if substantially similar content already exists
        const isDup = existing.some(e => {
          const overlap = textOverlap(content.slice(0, 200), e.content.slice(0, 200));
          return overlap > 0.6;
        });
        if (isDup) continue;

        const entry = createMemory(content, {
          layer: Layer.Episodic,
          tags: ['claude-code-memory'],
          source: `claude-memory:${file}`,
          confidence: 'observed',
        });

        writeEntry(hippoRoot, entry);
        existing.push(entry); // prevent self-dedup within batch
        imported++;
      }
    } catch { /* skip broken dirs */ }
  }

  return imported;
}

function cmdDedup(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const dryRun = Boolean(flags['dry-run']);
  const threshold = parseFloat(String(flags['threshold'] ?? '0.7'));

  const entries = loadAllEntries(hippoRoot);
  console.log(`Scanning ${entries.length} memories for duplicates (>=${(threshold * 100).toFixed(0)}% text overlap)${dryRun ? ' (dry run)' : ''}...\n`);

  const result = deduplicateStore(hippoRoot, { threshold, dryRun });

  if (result.removed === 0) {
    console.log('No duplicates found.');
    return;
  }

  // Group by reason
  const sameLayerSem = result.pairs.filter(p => p.keptLayer === 'semantic' && p.removedLayer === 'semantic');
  const sameLayerEpi = result.pairs.filter(p => p.keptLayer === 'episodic' && p.removedLayer === 'episodic');
  const crossLayer = result.pairs.filter(p => p.keptLayer !== p.removedLayer);

  console.log(`${dryRun ? 'Would remove' : 'Removed'} ${result.removed} duplicates:`);
  if (sameLayerSem.length > 0) {
    console.log(`  ${sameLayerSem.length} redundant semantic memories (consolidation regenerated near-identical patterns)`);
  }
  if (sameLayerEpi.length > 0) {
    console.log(`  ${sameLayerEpi.length} duplicate episodic memories (same lesson learned from multiple sources)`);
  }
  if (crossLayer.length > 0) {
    console.log(`  ${crossLayer.length} cross-layer duplicates (episodic content already consolidated into semantic)`);
  }

  // Show detailed pairs
  console.log('');
  const shown = result.pairs.slice(0, 15);
  for (const pair of shown) {
    const simPct = (pair.similarity * 100).toFixed(0);
    const action = dryRun ? 'Would remove' : 'Removed';
    console.log(`  ${simPct}% similar | kept [${pair.keptLayer}] strength=${pair.keptStrength.toFixed(2)}`);
    console.log(`    ${pair.keptContent.slice(0, 90)}`);
    console.log(`  ${action} [${pair.removedLayer}] strength=${pair.removedStrength.toFixed(2)}`);
    console.log(`    ${pair.removedContent.slice(0, 90)}`);
    console.log('');
  }
  if (result.pairs.length > 15) {
    console.log(`  ... and ${result.pairs.length - 15} more (run with --dry-run to see all)`);
  }
}

async function cmdSleep(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  // Tee stdout/stderr to a log file when --log-file is set. The SessionEnd
  // hook uses this so the output is captured somewhere the SessionStart hook
  // can re-display it next time the agent UI starts.
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : null;
  let restoreStdout: (() => void) | null = null;
  if (logFile) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `[hippo] ${new Date().toISOString()} consolidating memory...\n`, 'utf8');
      const origStdoutWrite = process.stdout.write.bind(process.stdout);
      const origStderrWrite = process.stderr.write.bind(process.stderr);
      const tee = (chunk: unknown) => {
        try {
          const buf = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          fs.appendFileSync(logFile, buf, 'utf8');
        } catch {
          // log failures are non-fatal — still write to the real stream
        }
      };
      process.stdout.write = ((chunk: any, enc?: any, cb?: any): boolean => {
        tee(chunk);
        return origStdoutWrite(chunk, enc, cb);
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: any, enc?: any, cb?: any): boolean => {
        tee(chunk);
        return origStderrWrite(chunk, enc, cb);
      }) as typeof process.stderr.write;
      restoreStdout = () => {
        process.stdout.write = origStdoutWrite;
        process.stderr.write = origStderrWrite;
      };
    } catch (err) {
      console.error(`[hippo] warning: could not open log file ${logFile}: ${(err as Error).message}`);
    }
  }

  try {
    await cmdSleepCore(hippoRoot, flags);
    if (logFile) console.log('[hippo] sleep complete');
  } catch (err) {
    if (logFile) console.log(`[hippo] sleep failed: ${(err as Error).message}`);
    throw err;
  } finally {
    if (restoreStdout) restoreStdout();
  }
}

/**
 * Render an api.sleep result as console output, byte-identical to the
 * pre-extraction inline implementation in cmdSleepCore.
 */
/** @internal — exported for snapshot tests (tests/cli-context-render-snapshot.test.ts). NOT a stable public API. */
export function renderSleepResult(result: api.SleepResult): void {
  console.log(`Running consolidation${result.dryRun ? ' (dry run)' : ''}...`);

  console.log(`\nResults:`);
  console.log(`   Active memories:  ${result.active}`);
  console.log(`   Removed (decayed): ${result.removed}`);
  console.log(`   Merged episodic:   ${result.mergedEpisodic}`);
  console.log(`   New semantic:      ${result.newSemantic}`);

  if (result.details && result.details.length > 0) {
    console.log('\nDetails:');
    for (const d of result.details) {
      console.log(d);
    }
  }

  if (result.dryRun) console.log('\n(dry run  - nothing written)');

  if (result.deduped && result.deduped.removed > 0) {
    const { removed, semDups, epiDups, crossDups } = result.deduped;
    const parts: string[] = [];
    if (semDups > 0) parts.push(`${semDups} redundant semantic patterns`);
    if (epiDups > 0) parts.push(`${epiDups} duplicate episodic lessons`);
    if (crossDups > 0) parts.push(`${crossDups} cross-layer duplicates`);
    console.log(`\nDeduped ${removed} duplicates (${parts.join(', ')}). Kept stronger copies.`);
  }

  if (result.audit) {
    if (result.audit.errorsRemoved > 0) {
      console.log(`\nAudit: removed ${result.audit.errorsRemoved} junk memories (too short/empty).`);
    }
    if (result.audit.warningCount > 0) {
      console.log(`Audit: ${result.audit.warningCount} low-quality memories detected (run \`hippo audit\` for details).`);
    }
  }

  if (result.shared !== undefined && result.shared > 0) {
    console.log(`\nAuto-shared ${result.shared} high-value memories to global store.`);
  }

  if (result.ambient) {
    console.log(`\n${renderAmbientSummary(result.ambient)}`);
  }

  if (result.graph && result.graph.tenants > 0) {
    const { tenants, entities, relations } = result.graph;
    console.log(
      `\nGraph: rebuilt ${tenants} tenant${tenants === 1 ? '' : 's'} (${entities} entities, ${relations} relations).`,
    );
  }
}

async function cmdSleepCore(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  // Phase 1: Auto-learn from git + MEMORY.md (CLI-only, uses process.cwd() / os.homedir()).
  // Stays in cli.ts; api.sleep covers Phase 2-6 only.
  if (!flags['no-learn']) {
    const config = loadConfig(hippoRoot);
    if (config.autoLearnOnSleep && isGitRepo(process.cwd())) {
      const { added } = learnFromRepo(hippoRoot, process.cwd(), 1);
      if (added > 0) console.log(`Auto-learned ${added} lessons from today's git commits.`);
    }

    // Also learn from Claude Code MEMORY.md files
    const memImported = learnFromMemoryMd(hippoRoot);
    if (memImported > 0) console.log(`Imported ${memImported} memories from Claude Code MEMORY.md files.`);
  }

  // Phase 2-6: Pure-storage pipeline (consolidate + dedup + audit + share + ambient).
  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const result = await api.sleep(ctx, {
    dryRun: Boolean(flags['dry-run']),
    noShare: Boolean(flags['no-share']),
  });
  renderSleepResult(result);
}

/**
 * Print the contents of the SessionEnd sleep log to stdout, then clear it.
 * Called from SessionStart hooks so the user sees the previous session's
 * consolidation output (SessionEnd hook output is invisible because the TUI
 * is tearing down when it runs).
 */
function cmdLastSleep(flags: Record<string, string | boolean | string[]>): void {
  const logPath = typeof flags['path'] === 'string'
    ? (flags['path'] as string)
    : defaultSleepLogPath();

  if (!fs.existsSync(logPath)) return;

  let content: string;
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch {
    return;
  }

  if (content.trim().length > 0) {
    console.log('=== Previous session hippo consolidation ===');
    process.stdout.write(content);
    if (!content.endsWith('\n')) console.log();
    console.log('===========================================');
  }

  if (!flags['keep']) {
    try { fs.unlinkSync(logPath); } catch { /* non-fatal */ }
  }
}

/**
 * SessionEnd entry point. Claude Code / OpenCode fire this on /exit while
 * tearing down the TUI, which kills any child that is still running when
 * the parent returns. Running sleep + capture synchronously here means both
 * get SIGTERM'd mid-consolidation.
 *
 * So we do the minimum inline (read stdin for transcript_path), then spawn
 * a fully detached Node child that runs sleep → capture and exit the parent
 * immediately. The child writes to the log file and survives TUI teardown;
 * the next SessionStart reads the log via `hippo last-sleep`.
 */
function cmdSessionEnd(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : null;

  // Read stdin synchronously. The SessionEnd hook payload carries
  // `transcript_path` as JSON; we extract it here and pass it to the worker
  // via argv so the detached child doesn't need to inherit stdin.
  let transcriptPath: string | null = null;
  try {
    const stdinText = fs.readFileSync(0, 'utf8');
    if (stdinText && stdinText.trim().startsWith('{')) {
      const payload = JSON.parse(stdinText) as Record<string, unknown>;
      if (typeof payload.transcript_path === 'string') {
        transcriptPath = payload.transcript_path;
      }
    }
  } catch {
    // No stdin, not JSON, or read failure — capture will fall back to
    // transcript auto-discovery.
  }

  const workerArgs: string[] = [process.argv[1], '__session-end-worker'];
  if (logFile) workerArgs.push('--log-file', logFile);
  if (transcriptPath) workerArgs.push('--transcript', transcriptPath);

  try {
    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    // If spawn fails, run inline as a last resort — better late output than
    // no consolidation at all.
    cmdSessionEndWorker(hippoRoot, flags);
    return;
  }
}

/**
 * Detached worker that runs sleep, then capture. Invoked via the internal
 * `__session-end-worker` subcommand (not user-facing). Failures in one stage
 * do not block the other.
 */
function cmdSessionEndWorker(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  try {
    cmdSleep(hippoRoot, flags);
  } catch {
    // sleep errors are already tee'd to the log file via cmdSleep's
    // `[hippo] sleep failed: ...` line. Continue to capture regardless.
  }
  try {
    const captureOpts: CaptureOptions = {
      source: 'last-session',
      transcriptPath: typeof flags['transcript'] === 'string'
        ? (flags['transcript'] as string)
        : undefined,
      logFile: typeof flags['log-file'] === 'string'
        ? (flags['log-file'] as string)
        : undefined,
      dryRun: false,
      global: false,
      tenantId: resolveTenantId({}),
    };
    cmdCapture(hippoRoot, captureOpts);
  } catch {
    // Same treatment — the failure line is already in the log.
  }
}

function loadCodexWrapperMetadata(): CodexWrapperMetadata {
  const { metadataPath } = resolveCodexWrapperPaths();
  if (!fs.existsSync(metadataPath)) {
    throw new Error('Codex wrapper is not installed. Run `hippo hook install codex` first.');
  }
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as CodexWrapperMetadata;
}

function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[ \t"&()^<>|]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnRealCodex(
  realCodexPath: string,
  forwardArgs: string[],
  cwd: string,
): ReturnType<typeof spawn> {
  const ext = path.extname(realCodexPath).toLowerCase();

  if (process.platform === 'win32' && ext === '.ps1') {
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', realCodexPath, ...forwardArgs],
      { cwd, stdio: 'inherit', windowsHide: false },
    );
  }

  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    const command = `"${realCodexPath}"${forwardArgs.length > 0 ? ` ${forwardArgs.map(quoteCmdArg).join(' ')}` : ''}`;
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', command],
      { cwd, stdio: 'inherit', windowsHide: false },
    );
  }

  return spawn(realCodexPath, forwardArgs, { cwd, stdio: 'inherit', windowsHide: false });
}

function cmdCodexRun(
  hippoRoot: string,
  args: string[],
): void {
  const metadata = loadCodexWrapperMetadata();
  const startedAtMs = Date.now();
  const historyPath = metadata.historyPath;
  const startOffsetBytes = fs.existsSync(historyPath) ? fs.statSync(historyPath).size : 0;

  try {
    cmdLastSleep({ path: metadata.logFile });
  } catch {
    // best-effort only
  }

  const child = spawnRealCodex(metadata.realCodexPath, args, process.cwd());
  child.on('error', (err) => {
    console.error(`Failed to launch Codex: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    const workerArgs = [
      process.argv[1],
      '__codex-session-end-worker',
      '--codex-home',
      path.dirname(historyPath),
      '--history-path',
      historyPath,
      '--start-offset',
      String(startOffsetBytes),
      '--started-at',
      String(startedAtMs),
      '--log-file',
      metadata.logFile,
    ];

    try {
      const worker = spawn(process.execPath, workerArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      worker.unref();
    } catch {
      // Fall back to the inline path if the detached worker cannot be created.
      cmdCodexSessionEndWorker(hippoRoot, {
        'codex-home': path.dirname(historyPath),
        'history-path': historyPath,
        'start-offset': String(startOffsetBytes),
        'started-at': String(startedAtMs),
        'log-file': metadata.logFile,
      });
    }

    if (signal) {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exit(1);
      }
      return;
    }
    process.exit(code ?? 0);
  });
}

function cmdCodexSessionEndWorker(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined;

  try {
    cmdSleep(hippoRoot, logFile ? { 'log-file': logFile } : {});
  } catch {
    // sleep errors are already written via cmdSleep
  }

  try {
    const codexHome = typeof flags['codex-home'] === 'string'
      ? (flags['codex-home'] as string)
      : path.join(os.homedir(), '.codex');
    const historyPath = typeof flags['history-path'] === 'string'
      ? (flags['history-path'] as string)
      : path.join(codexHome, 'history.jsonl');
    const startOffsetBytes = parseInt(String(flags['start-offset'] ?? '0'), 10) || 0;
    const startedAtMs = parseInt(String(flags['started-at'] ?? Date.now()), 10) || Date.now();
    const transcriptPath = resolveCodexSessionTranscript({
      codexHome,
      historyPath,
      startOffsetBytes,
      startedAtMs,
    }) ?? undefined;

    const captureOpts: CaptureOptions = {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId: resolveTenantId({}),
    };
    cmdCapture(hippoRoot, captureOpts);
  } catch {
    // capture path logs its own failures
  }
}

function shouldAutoInstallCodexWrapper(currentCommand: string, currentArgs: string[]): boolean {
  if (process.env.HIPPO_SKIP_AUTO_INTEGRATIONS === '1') return false;
  if (!['context', 'remember', 'recall', 'sleep', 'capture', 'outcome', 'status', 'init'].includes(currentCommand)) {
    return false;
  }
  if (currentCommand === 'init' && currentArgs.includes('--no-hooks')) return false;
  return true;
}

function maybeAutoInstallCodexWrapper(currentCommand: string, currentArgs: string[]): void {
  if (!shouldAutoInstallCodexWrapper(currentCommand, currentArgs)) return;
  try {
    ensureCodexWrapperInstalled();
  } catch {
    // best-effort only
  }
}

function cmdStatus(hippoRoot: string): void {
  requireInit(hippoRoot);

  const entries = loadAllEntries(hippoRoot);
  const stats = loadStats(hippoRoot);
  const now = new Date();

  const byLayer = {
    [Layer.Buffer]: 0,
    [Layer.Episodic]: 0,
    [Layer.Semantic]: 0,
    [Layer.Trace]: 0,
  };

  const byConfidence: Record<string, number> = {
    verified: 0,
    observed: 0,
    inferred: 0,
    stale: 0,
  };

  let totalStrength = 0;
  let pinned = 0;
  let atRisk = 0; // strength < 0.2

  for (const e of entries) {
    const s = calculateStrength(e, now);
    byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    totalStrength += s;
    if (e.pinned) pinned++;
    if (s < 0.2) atRisk++;
    const conf = resolveConfidence(e, now);
    byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
  }

  const avgStrength = entries.length > 0 ? totalStrength / entries.length : 0;

  console.log('Hippo Status');
  console.log('---------------------------');
  console.log(`Total memories:    ${entries.length}`);
  console.log(`  Buffer:          ${byLayer[Layer.Buffer]}`);
  console.log(`  Episodic:        ${byLayer[Layer.Episodic]}`);
  console.log(`  Semantic:        ${byLayer[Layer.Semantic]}`);
  console.log(`  Trace:           ${byLayer[Layer.Trace]}`);
  const conflictCount = listMemoryConflicts(hippoRoot).length;

  console.log(`Pinned:            ${pinned}`);
  console.log(`At risk (<0.2):    ${atRisk}`);
  console.log(`Open conflicts:    ${conflictCount}`);
  console.log(`Avg strength:      ${fmt(avgStrength)}`);
  console.log('');
  console.log('Confidence breakdown:');
  console.log(`  Verified:        ${byConfidence['verified'] ?? 0}`);
  console.log(`  Observed:        ${byConfidence['observed'] ?? 0}`);
  console.log(`  Inferred:        ${byConfidence['inferred'] ?? 0}`);
  console.log(`  Stale:           ${byConfidence['stale'] ?? 0}`);
  console.log('');
  console.log(`Total remembered:  ${(stats as Record<string,number>)['total_remembered'] ?? 0}`);
  console.log(`Total recalled:    ${(stats as Record<string,number>)['total_recalled'] ?? 0}`);
  console.log(`Total forgotten:   ${(stats as Record<string,number>)['total_forgotten'] ?? 0}`);

  const runs = (stats as Record<string, unknown[]>)['consolidation_runs'] ?? [];
  if (Array.isArray(runs) && runs.length > 0) {
    const last = runs[runs.length - 1] as Record<string, unknown>;
    console.log(`Last sleep:        ${last['timestamp']}`);
  } else {
    console.log(`Last sleep:        never`);
  }

  // Embedding status (provider-aware)
  const embedProvider = (() => {
    try {
      return resolveEmbeddingProvider(hippoRoot);
    } catch {
      return null;
    }
  })();
  console.log('');
  if (!embedProvider) {
    console.log(`Embeddings:        misconfigured (check embeddings.provider / apiBaseUrl), BM25 only`);
  } else {
    const embeddingsDisabled = loadConfig(hippoRoot).embeddings.enabled === false;
    const embAvail = embedProvider.isAvailable();
    if (embeddingsDisabled) {
      console.log(`Embeddings:        disabled in config (embeddings.enabled = false), BM25 only`);
    } else if (embedProvider.kind === 'local') {
      console.log(`Embeddings:        ${embAvail ? `available [${embedProvider.id}]` : 'not installed (BM25 only)'}`);
    } else if (embAvail) {
      console.log(`Embeddings:        ${embedProvider.kind} api [${embedProvider.id}]`);
    } else {
      console.log(`Embeddings:        ${embedProvider.kind} configured but ${embedProvider.keyEnv} not set (BM25 only)`);
    }
    // Show cached counts whenever vectors exist on disk (even when disabled or
    // the key was removed), so the user still sees what is already indexed.
    const embIndex = loadEmbeddingIndex(hippoRoot);
    if (embAvail || Object.keys(embIndex).length > 0) {
      const activeIds = new Set(entries.map((e) => e.id));
      const activeEmbedded = Object.keys(embIndex).filter((id) => activeIds.has(id)).length;
      const orphaned = Object.keys(embIndex).length - activeEmbedded;
      const dims = Object.values(embIndex)[0]?.length;
      let line = `Embedded:          ${activeEmbedded}/${entries.length} memories`;
      if (dims) line += ` (${dims}-dim)`;
      if (orphaned > 0) line += ` (${orphaned} orphaned, run \`hippo embed\` to prune)`;
      console.log(line);
      if (embeddingModelRequiresReindex(hippoRoot, embedProvider.id, embIndex)) {
        console.log(`                   model changed, run \`hippo embed\` to reindex`);
      }
    }
  }

  // Physics status
  try {
    const db = openHippoDb(hippoRoot);
    try {
      const physicsMap = loadPhysicsState(db);
      if (physicsMap.size > 0) {
        const particles = Array.from(physicsMap.values());
        const physConfig = loadConfig(hippoRoot);
        const energy = computeSystemEnergy(particles, physConfig.physics.G_memory);
        let sumVelMag = 0;
        let maxVelMag = 0;
        for (const p of particles) {
          const mag = vecNorm(p.velocity);
          sumVelMag += mag;
          if (mag > maxVelMag) maxVelMag = mag;
        }
        const avgVelMag = sumVelMag / particles.length;
        console.log('');
        console.log(`Physics: ${particles.length} particles, energy: ${fmt(energy.total, 4)} (KE: ${fmt(energy.kinetic, 4)}, PE: ${fmt(energy.potential, 4)}), avg vel: ${fmt(avgVelMag, 4)}`);
      }
    } finally {
      closeHippoDb(db);
    }
  } catch {
    // Physics table may not exist yet — degrade gracefully
  }
}

function cmdOutcome(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const good = Boolean(flags['good']);
  const bad = Boolean(flags['bad']);

  if (!good && !bad) {
    console.error('Specify --good or --bad');
    process.exit(1);
  }

  // Behavior fix (v1.11.3): cmdOutcome used to bypass api.outcome and do its
  // own readEntry/writeEntry inline, which silently skipped the audit_log
  // emission that the MCP outcome path already has via api.outcome. T6
  // rewires through api.outcome so every successful CLI 'outcome' call now
  // writes one audit_log row per affected id, matching MCP parity.
  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const specificId = flags['id'] ? String(flags['id']) : null;

  let updated: number;
  if (specificId) {
    updated = api.outcome(ctx, [specificId], good).applied;
  } else {
    const r = api.outcomeForLastRecall(ctx, good);
    if (r.ids.length === 0) {
      console.log('No recent recall to apply outcome to. Use --id <id> to target a specific memory.');
      return;
    }
    updated = r.applied;
  }

  console.log(`Applied ${good ? 'positive' : 'negative'} outcome to ${updated} memor${updated === 1 ? 'y' : 'ies'}`);
}

function cmdForget(
  hippoRoot: string,
  id: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);

  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };

  // A3: raw memories (Slack / GitHub connector ingestion) are append-only — a
  // BEFORE-DELETE trigger aborts any delete. archiveRaw is the sanctioned
  // removal path; it records ctx.actor as the archiver for provenance.
  if (flags['archive'] === true) {
    const reason = typeof flags['reason'] === 'string' ? flags['reason'] : null;
    if (!reason) {
      console.error('hippo forget --archive requires --reason "<why>" (recorded on the archive).');
      process.exit(1);
    }
    try {
      api.archiveRaw(ctx, id, reason);
      updateStats(hippoRoot, { forgotten: 1 });
      console.log(`Archived ${id}`);
    } catch (err) {
      console.error(`Could not archive ${id}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  try {
    api.forget(ctx, id);
    updateStats(hippoRoot, { forgotten: 1 });
    console.log(`Forgot ${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/append-only/i.test(msg)) {
      // The delete was refused by the append-only trigger — this is a raw
      // memory, not a missing one. Point the user at the archive path.
      console.error(
        `Cannot forget ${id}: it is a raw, append-only memory. ` +
        `Archive it instead: hippo forget ${id} --archive --reason "<why>"`,
      );
    } else {
      console.error(`Memory not found: ${id}`);
    }
    process.exit(1);
  }
}

function cmdInspect(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  const entry = readEntry(hippoRoot, id, resolveTenantId({}));
  if (!entry) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }

  const now = new Date();
  const currentStrength = calculateStrength(entry, now);
  const lastRetrieved = new Date(entry.last_retrieved);
  const created = new Date(entry.created);
  const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  const daysSince = (now.getTime() - lastRetrieved.getTime()) / (1000 * 60 * 60 * 24);

  const effectiveConfidence = resolveConfidence(entry, now);

  console.log(`Memory: ${entry.id}`);
  console.log('---------------------------');
  console.log(`Layer:            ${entry.layer}`);
  console.log(`Confidence:       ${entry.confidence}${effectiveConfidence !== entry.confidence ? ` (effective: ${effectiveConfidence})` : ''}`);
  console.log(`Created:          ${entry.created} (${fmt(ageDays, 1)}d ago)`);
  console.log(`Last retrieved:   ${entry.last_retrieved} (${fmt(daysSince, 1)}d ago)`);
  console.log(`Retrieval count:  ${entry.retrieval_count}`);
  console.log(`Strength (live):  ${fmt(currentStrength)} (stored: ${fmt(entry.strength)})`);
  console.log(`Half-life:        ${entry.half_life_days}d`);
  console.log(`Emotional:        ${entry.emotional_valence}`);
  console.log(`Schema fit:       ${entry.schema_fit}`);
  console.log(`Pinned:           ${entry.pinned}`);
  console.log(`Tags:             ${entry.tags.join(', ') || 'none'}`);
  const rewardFactor = calculateRewardFactor(entry);
  const pos = entry.outcome_positive ?? 0;
  const neg = entry.outcome_negative ?? 0;
  const outcomeLabel = pos === 0 && neg === 0
    ? 'none'
    : `+${pos} / -${neg} (reward factor: ${fmt(rewardFactor)})`;
  console.log(`Outcomes:         ${outcomeLabel}`);
  if (entry.conflicts_with.length > 0) {
    console.log(`Conflicts with:   ${entry.conflicts_with.join(', ')}`);
  }
  console.log('');
  console.log('Content:');
  console.log('-'.repeat(40));
  console.log(entry.content);
}

function printActiveTaskSnapshot(snapshot: TaskSnapshot): void {
  console.log('## Active Task Snapshot\n');
  console.log(`- Task: ${snapshot.task}`);
  console.log(`- Status: ${snapshot.status}`);
  console.log(`- Updated: ${snapshot.updated_at}`);
  console.log(`- Source: ${snapshot.source}`);
  if (snapshot.session_id) {
    console.log(`- Session: ${snapshot.session_id}`);
  }
  console.log('');
  console.log('### Summary');
  console.log(snapshot.summary);
  console.log('');
  console.log('### Next step');
  console.log(snapshot.next_step);
  console.log('');
}

function printSessionEvents(events: SessionEvent[]): void {
  if (events.length === 0) {
    console.log('No session events found.');
    return;
  }

  const latest = events[events.length - 1]!;
  console.log('## Recent Session Trail\n');
  console.log(`- Session: ${latest.session_id}`);
  console.log(`- Task: ${latest.task ?? 'n/a'}`);
  console.log(`- Updated: ${latest.created_at}`);
  console.log('');

  for (const event of events) {
    console.log(`- [${event.created_at}] (${event.event_type}) ${event.content}`);
  }
  console.log('');
}

function cmdConflicts(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const conflicts = listMemoryConflicts(hippoRoot, String(flags['status'] ?? 'open'));
  if (flags['json']) {
    console.log(JSON.stringify({ conflicts }, null, 2));
    return;
  }

  if (conflicts.length === 0) {
    console.log('No memory conflicts found.');
    return;
  }

  console.log(`Found ${conflicts.length} memory conflict${conflicts.length === 1 ? '' : 's'}\n`);
  for (const conflict of conflicts) {
    console.log(`--- conflict_${conflict.id} score=${fmt(conflict.score, 3)} status=${conflict.status}`);
    console.log(`    ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
    console.log(`    reason: ${conflict.reason}`);
    console.log('');
  }
}

function cmdResolve(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const rawId = args[0] ?? '';
  // Accept "42" or "conflict_42"
  const conflictId = parseInt(rawId.replace(/^conflict_/, ''), 10);
  if (isNaN(conflictId)) {
    console.error('Usage: hippo resolve <conflict_id> --keep <memory_id> [--forget]');
    process.exit(1);
  }

  const tenantId = resolveTenantId({});
  const keepId = String(flags['keep'] ?? '').trim();
  if (!keepId) {
    // Show the conflict details to help the user decide
    const conflicts = listMemoryConflicts(hippoRoot, 'open', tenantId);
    const conflict = conflicts.find((c) => c.id === conflictId);
    if (!conflict) {
      console.error(`Conflict ${conflictId} not found or already resolved.`);
      process.exit(1);
    }

    console.log(`Conflict ${conflictId}:`);
    console.log(`  ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
    console.log(`  Reason: ${conflict.reason}`);
    console.log('');

    const entryA = readEntry(hippoRoot, conflict.memory_a_id, tenantId);
    const entryB = readEntry(hippoRoot, conflict.memory_b_id, tenantId);
    if (entryA) {
      console.log(`  [A] ${conflict.memory_a_id}:`);
      console.log(`      ${entryA.content.slice(0, 120)}${entryA.content.length > 120 ? '...' : ''}`);
    }
    if (entryB) {
      console.log(`  [B] ${conflict.memory_b_id}:`);
      console.log(`      ${entryB.content.slice(0, 120)}${entryB.content.length > 120 ? '...' : ''}`);
    }
    console.log('');
    console.log(`Resolve with: hippo resolve ${conflictId} --keep <memory_id> [--forget]`);
    return;
  }

  const forgetLoser = Boolean(flags['forget']);
  const result = resolveConflict(hippoRoot, conflictId, keepId, forgetLoser, tenantId);

  if (!result) {
    console.error(`Could not resolve conflict ${conflictId}. Check the ID and --keep value.`);
    process.exit(1);
  }

  const action = forgetLoser ? 'deleted' : 'weakened (half-life halved)';
  console.log(`Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`);
}

function cmdSnapshot(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'save') {
    const task = String(flags['task'] ?? '').trim();
    const summary = String(flags['summary'] ?? '').trim();
    const nextStep = String(flags['next-step'] ?? '').trim();
    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim();

    if (!task || !summary || !nextStep) {
      console.error('Usage: hippo snapshot save --task <task> --summary <summary> --next-step <step> [--source <source>] [--session <session-id>]');
      process.exit(1);
    }

    const snapshot = saveActiveTaskSnapshot(hippoRoot, resolveTenantId({}), {
      task,
      summary,
      next_step: nextStep,
      source: String(flags['source'] ?? 'cli'),
      session_id: sessionId || null,
    });

    console.log(`Saved active task snapshot #${snapshot.id}`);
    console.log(`   Task: ${snapshot.task}`);
    console.log(`   Next: ${snapshot.next_step}`);
    if (snapshot.session_id) {
      console.log(`   Session: ${snapshot.session_id}`);
    }
    return;
  }

  if (subcommand === 'clear') {
    const cleared = clearActiveTaskSnapshot(hippoRoot, resolveTenantId({}), String(flags['status'] ?? 'cleared'));
    if (!cleared) {
      console.log('No active task snapshot to clear.');
      return;
    }
    console.log('Cleared active task snapshot.');
    return;
  }

  if (subcommand === 'show') {
    const snapshot = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
    if (!snapshot) {
      if (flags['json']) {
        console.log(JSON.stringify({ snapshot: null }));
      } else {
        console.log('No active task snapshot saved.');
      }
      return;
    }

    if (flags['json']) {
      console.log(JSON.stringify({ snapshot }, null, 2));
      return;
    }

    printActiveTaskSnapshot(snapshot);
    return;
  }

  console.error('Usage: hippo snapshot <save|show|clear>');
  process.exit(1);
}

function cmdSession(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';
  const sessionId = String(flags['id'] ?? flags['session'] ?? '').trim();
  const task = String(flags['task'] ?? '').trim();
  const limit = Math.max(1, parseInt(String(flags['limit'] ?? '8'), 10) || 8);

  if (subcommand === 'log') {
    const eventType = String(flags['type'] ?? 'note').trim();
    const content = String(flags['content'] ?? '').trim();

    if (!sessionId || !content) {
      console.error('Usage: hippo session log --id <session-id> --content <text> [--type <type>] [--task <task>] [--source <source>]');
      process.exit(1);
    }

    const event = appendSessionEvent(hippoRoot, resolveTenantId({}), {
      session_id: sessionId,
      task: task || null,
      event_type: eventType || 'note',
      content,
      source: String(flags['source'] ?? 'cli'),
    });

    console.log(`Logged session event #${event.id}`);
    console.log(`   Session: ${event.session_id}`);
    console.log(`   Type: ${event.event_type}`);
    return;
  }

  if (subcommand === 'show') {
    const events = listSessionEvents(hippoRoot, resolveTenantId({}), {
      session_id: sessionId || undefined,
      task: task || undefined,
      limit,
    });

    if (flags['json']) {
      console.log(JSON.stringify({ events }, null, 2));
      return;
    }

    printSessionEvents(events);
    return;
  }

  if (subcommand === 'latest') {
    const snapshot = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
    const events = listSessionEvents(hippoRoot, resolveTenantId({}), {
      session_id: sessionId || snapshot?.session_id || undefined,
      limit,
    });

    if (flags['json']) {
      console.log(JSON.stringify({ snapshot: snapshot ?? null, events }, null, 2));
      return;
    }

    if (snapshot) {
      printActiveTaskSnapshot(snapshot);
    } else {
      console.log('No active task snapshot.');
      console.log('');
    }
    printSessionEvents(events);
    return;
  }

  if (subcommand === 'complete') {
    const outcome = String(flags['outcome'] ?? '').trim();
    const summary = String(flags['summary'] ?? '').trim();
    const validOutcomes = ['success', 'failure', 'partial'];

    if (!sessionId) {
      console.error('Usage: hippo session complete --session <session-id> --outcome <success|failure|partial> [--summary "..."]');
      process.exit(1);
    }
    if (!validOutcomes.includes(outcome)) {
      console.error(`Invalid outcome: "${outcome}". Must be one of: ${validOutcomes.join(', ')}.`);
      process.exit(1);
    }

    const metadata: Record<string, unknown> = { ended_at: new Date().toISOString() };
    if (summary) metadata.summary = summary;

    const event = appendSessionEvent(hippoRoot, resolveTenantId({}), {
      session_id: sessionId,
      task: task || null,
      event_type: 'session_complete',
      content: outcome,
      source: String(flags['source'] ?? 'cli'),
      metadata,
    });

    console.log(`Completed session ${event.session_id} with outcome=${outcome} (event #${event.id})`);
    return;
  }

  if (subcommand === 'resume') {
    const handoff = loadLatestHandoff(hippoRoot, resolveTenantId({}), sessionId || undefined);
    if (!handoff) {
      console.log('No handoff to resume from.');
      return;
    }

    const lines: string[] = [
      '## Session Handoff (resumed)',
      '',
      `- Session: ${handoff.sessionId}`,
      `- Updated: ${handoff.updatedAt}`,
    ];
    if (handoff.taskId) lines.push(`- Task: ${handoff.taskId}`);
    if (handoff.repoRoot) lines.push(`- Repo: ${handoff.repoRoot}`);
    lines.push('', '### Summary', handoff.summary);
    if (handoff.nextAction) {
      lines.push('', '### Next action', handoff.nextAction);
    }
    if (handoff.artifacts && handoff.artifacts.length > 0) {
      lines.push('', '### Artifacts');
      for (const artifact of handoff.artifacts) {
        lines.push(`- ${artifact}`);
      }
    }
    lines.push('');
    console.log(lines.join('\n'));
    return;
  }

  console.error('Usage: hippo session <log|show|latest|resume|complete>');
  process.exit(1);
}

function printHandoff(handoff: SessionHandoff): void {
  console.log('## Session Handoff\n');
  console.log(`- Session: ${handoff.sessionId}`);
  console.log(`- Updated: ${handoff.updatedAt}`);
  if (handoff.taskId) console.log(`- Task: ${handoff.taskId}`);
  if (handoff.repoRoot) console.log(`- Repo: ${handoff.repoRoot}`);
  console.log('');
  console.log('### Summary');
  console.log(handoff.summary);
  if (handoff.nextAction) {
    console.log('');
    console.log('### Next action');
    console.log(handoff.nextAction);
  }
  if (handoff.artifacts && handoff.artifacts.length > 0) {
    console.log('');
    console.log('### Artifacts');
    for (const artifact of handoff.artifacts) {
      console.log(`- ${artifact}`);
    }
  }
  console.log('');
}

function cmdHandoff(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'latest';

  if (subcommand === 'create') {
    const summary = String(flags['summary'] ?? '').trim();
    if (!summary) {
      console.error('Usage: hippo handoff create --summary "..." [--next "..."] [--session <id>] [--task <id>] [--artifact <path>...]');
      process.exit(1);
    }

    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || `fallback-${Date.now()}-${process.pid}`;
    const nextAction = String(flags['next'] ?? '').trim() || undefined;
    const taskId = String(flags['task'] ?? '').trim() || undefined;
    const artifactFlag = flags['artifact'];
    const artifacts: string[] = Array.isArray(artifactFlag)
      ? artifactFlag
      : (typeof artifactFlag === 'string' ? [artifactFlag] : []);

    const handoff = saveSessionHandoff(hippoRoot, resolveTenantId({}), {
      version: 1,
      sessionId,
      repoRoot: process.cwd(),
      taskId,
      summary,
      nextAction,
      artifacts,
    });

    console.log(`Created session handoff for session ${handoff.sessionId}`);
    console.log(`   Summary: ${handoff.summary}`);
    if (handoff.nextAction) console.log(`   Next: ${handoff.nextAction}`);
    if (handoff.artifacts && handoff.artifacts.length > 0) {
      console.log(`   Artifacts: ${handoff.artifacts.join(', ')}`);
    }
    return;
  }

  if (subcommand === 'latest') {
    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || undefined;
    const handoff = loadLatestHandoff(hippoRoot, resolveTenantId({}), sessionId);

    if (!handoff) {
      if (flags['json']) {
        console.log(JSON.stringify({ handoff: null }));
      } else {
        console.log('No session handoff found.');
      }
      return;
    }

    if (flags['json']) {
      console.log(JSON.stringify({ handoff }, null, 2));
      return;
    }

    printHandoff(handoff);
    return;
  }

  if (subcommand === 'show') {
    const idArg = args[1];
    if (!idArg) {
      console.error('Usage: hippo handoff show <id> [--json]');
      process.exit(1);
    }

    const handoffId = parseInt(idArg, 10);
    if (!Number.isFinite(handoffId) || handoffId <= 0) {
      console.error(`Invalid handoff ID: ${idArg}`);
      process.exit(1);
    }

    const handoff = loadHandoffById(hippoRoot, resolveTenantId({}), handoffId);

    if (!handoff) {
      if (flags['json']) {
        console.log(JSON.stringify({ handoff: null }));
      } else {
        console.log(`No handoff found with ID ${handoffId}.`);
      }
      return;
    }

    if (flags['json']) {
      console.log(JSON.stringify({ handoff }, null, 2));
      return;
    }

    printHandoff(handoff);
    return;
  }

  console.error('Usage: hippo handoff <create|latest|show>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// E2 prediction first-class object (v0.31)
// docs/plans/2026-05-26-e2-prediction-object.md
// ---------------------------------------------------------------------------

function cmdPredict(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      console.error(`Invalid prediction id: "${idRaw}"`);
      process.exit(1);
    }
    const stateRaw = typeof flags['state'] === 'string' ? flags['state'].trim() : '';
    if (!predictionsModule.VALID_CLOSURE_STATES.has(stateRaw as predictionsModule.ClosureState) || stateRaw === 'open') {
      console.error(`Invalid --state: "${stateRaw}". Must be one of: closed | closed-unknown.`);
      process.exit(1);
    }
    const actualRaw = flags['actual'];
    const actualValue = actualRaw !== undefined ? Number(actualRaw) : undefined;
    if (actualRaw !== undefined && !Number.isFinite(actualValue)) {
      console.error(`Invalid --actual: "${actualRaw}". Must be a number.`);
      process.exit(1);
    }
    const noteRaw = flags['note'];
    const closureNote = typeof noteRaw === 'string' ? noteRaw : undefined;

    const closed = predictionsModule.closePrediction(hippoRoot, tenantId, id, {
      closureState: stateRaw as predictionsModule.ClosureState,
      actualValue,
      closureNote,
    });
    console.log(`Prediction ${closed.id} closed: state=${closed.closureState}${closed.actualValue !== null ? ` actual=${closed.actualValue}` : ''}`);
    return;
  }

  if (subcommand === 'list') {
    const classTagRaw = flags['class'];
    const classTag = typeof classTagRaw === 'string' ? classTagRaw.trim() : '';
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }

    let results;
    if (status === 'open') {
      results = predictionsModule.loadOpenPredictions(hippoRoot, tenantId, {
        classTag: classTag || undefined,
        limit,
      });
    } else if (status === 'all') {
      // No closure-state filter; pull both via loadPredictionsByClass if class given
      if (classTag) {
        results = predictionsModule.loadPredictionsByClass(hippoRoot, tenantId, classTag, { limit });
      } else {
        // No class filter + status=all = pull open + closed across all classes
        // (kept simple: report open via loadOpenPredictions; closed via two
        // class scans isn't symmetrical. v1 callers typically pass --class.)
        results = predictionsModule.loadOpenPredictions(hippoRoot, tenantId, { limit });
      }
    } else {
      if (!predictionsModule.VALID_CLOSURE_STATES.has(status as predictionsModule.ClosureState)) {
        console.error(`Invalid --status: "${status}". Must be one of: open | closed | closed-unknown | all.`);
        process.exit(1);
      }
      if (classTag) {
        results = predictionsModule.loadPredictionsByClass(hippoRoot, tenantId, classTag, {
          closureState: status as predictionsModule.ClosureState,
          limit,
        });
      } else {
        // status filter without class — scan all classes is more complex; v1 requires --class for non-default status
        console.error('--status filter (non-open) requires --class to be set.');
        process.exit(1);
      }
    }

    if (results.length === 0) {
      console.log(classTag ? `No predictions in class "${classTag}".` : 'No predictions.');
      return;
    }
    console.log(`Found ${results.length} predictions:\n`);
    for (const p of results) {
      const estPart = p.estimateValue !== null ? ` estimate=${p.estimateValue}${p.estimateUnit ? ` ${p.estimateUnit}` : ''}` : '';
      const actPart = p.actualValue !== null ? ` actual=${p.actualValue}` : '';
      const tgtPart = p.targetDate ? ` target=${p.targetDate}` : '';
      console.log(`#${p.id} [${p.closureState}] class=${p.classTag}${estPart}${actPart}${tgtPart}`);
      console.log(`    ${p.claimText}`);
      if (p.closureNote) console.log(`    note: ${p.closureNote}`);
    }
    return;
  }

  if (subcommand === 'show') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo predict show <id>');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      console.error(`Invalid prediction id: "${idRaw}"`);
      process.exit(1);
    }
    const pred = predictionsModule.loadPredictionById(hippoRoot, tenantId, id);
    if (!pred) {
      console.error(`Prediction ${id} not found.`);
      process.exit(1);
    }
    console.log(`Prediction #${pred.id}`);
    console.log(`  class: ${pred.classTag}`);
    console.log(`  claim: ${pred.claimText}`);
    console.log(`  state: ${pred.closureState}`);
    if (pred.estimateValue !== null) console.log(`  estimate: ${pred.estimateValue}${pred.estimateUnit ? ' ' + pred.estimateUnit : ''}`);
    if (pred.targetDate) console.log(`  target: ${pred.targetDate}`);
    if (pred.actualValue !== null) console.log(`  actual: ${pred.actualValue}`);
    if (pred.closedAt) console.log(`  closed: ${pred.closedAt}`);
    if (pred.closureNote) console.log(`  note: ${pred.closureNote}`);
    if (pred.memoryId) console.log(`  memory: ${pred.memoryId}`);
    console.log(`  created: ${pred.createdAt}`);
    return;
  }

  if (subcommand === 'baserate') {
    // J3 reference-class / planning-fallacy detector
    const classTagRaw = flags['class'];
    if (typeof classTagRaw !== 'string' || !classTagRaw.trim()) {
      console.error('Usage: hippo predict baserate --class <c>');
      process.exit(1);
    }
    const baserate = predictionsModule.computePredictionBaserate(
      hippoRoot,
      tenantId,
      classTagRaw.trim(),
    );
    if (baserate.nClosed === 0) {
      console.log(`No closed predictions in class "${baserate.classTag}" yet.`);
      console.log(`  Create one with: hippo predict "<claim>" --class ${baserate.classTag} --estimate N`);
      console.log(`  Close it later:  hippo predict close <id> --state closed --actual N`);
      return;
    }
    console.log(baserate.summary);
    console.log(`  n_closed:         ${baserate.nClosed}`);
    console.log(`  n_ratio_eligible: ${baserate.nRatioEligible}`);
    if (baserate.meanEstimate !== null) console.log(`  mean_estimate:    ${baserate.meanEstimate.toFixed(3)}`);
    if (baserate.meanActual !== null)   console.log(`  mean_actual:      ${baserate.meanActual.toFixed(3)}`);
    if (baserate.meanRatio !== null)    console.log(`  mean_ratio:       ${baserate.meanRatio.toFixed(3)}x`);
    if (baserate.p50Ratio !== null)     console.log(`  p50_ratio:        ${baserate.p50Ratio.toFixed(3)}x`);
    if (baserate.mae !== null)          console.log(`  mae:              ${baserate.mae.toFixed(3)}`);
    return;
  }

  // Default subcommand: create. args[0] is the claim text.
  const claimText = subcommand;
  if (!claimText) {
    console.error('Usage: hippo predict "<claim>" --class <c> [--estimate <v>] [--unit <u>] [--target <YYYY-MM-DD>]');
    console.error('       hippo predict close <id> --state <closed|closed-unknown> [--actual <v>] [--note "..."]');
    console.error('       hippo predict list [--class X] [--status open|closed|closed-unknown|all] [--limit N]');
    console.error('       hippo predict show <id>');
    process.exit(1);
  }
  const classTagRaw = flags['class'];
  if (typeof classTagRaw !== 'string' || !classTagRaw.trim()) {
    console.error('--class is required for prediction creation.');
    process.exit(1);
  }
  const classTag = classTagRaw.trim();
  const estimateRaw = flags['estimate'];
  const estimateValue = estimateRaw !== undefined ? Number(estimateRaw) : undefined;
  if (estimateRaw !== undefined && !Number.isFinite(estimateValue)) {
    console.error(`Invalid --estimate: "${estimateRaw}". Must be a number.`);
    process.exit(1);
  }
  const unitRaw = flags['unit'];
  const estimateUnit = typeof unitRaw === 'string' ? unitRaw : undefined;
  const targetRaw = flags['target'];
  const targetDate = typeof targetRaw === 'string' ? targetRaw : undefined;

  const created = predictionsModule.savePrediction(hippoRoot, tenantId, {
    classTag,
    claimText,
    estimateValue,
    estimateUnit,
    targetDate,
  });
  console.log(`Prediction recorded: #${created.id} class=${created.classTag}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}

function cmdDecide(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = decisionsModule.loadDecisions(hippoRoot, tenantId, { limit });
    } else {
      if (!decisionsModule.VALID_DECISION_STATES.has(status as decisionsModule.DecisionStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      results = decisionsModule.loadDecisions(hippoRoot, tenantId, {
        status: status as decisionsModule.DecisionStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No decisions.');
      return;
    }
    console.log(`Found ${results.length} decisions:\n`);
    for (const d of results) {
      const supPart = d.supersededBy !== null ? ` superseded_by=#${d.supersededBy}` : '';
      console.log(`#${d.id} [${d.status}]${supPart} memory=${d.memoryId ?? '-'}`);
      console.log(`    ${d.decisionText}`);
      if (d.context) console.log(`    context: ${d.context}`);
    }
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo decide get <id>');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      console.error(`Invalid decision id: "${idRaw}"`);
      process.exit(1);
    }
    const decision = decisionsModule.loadDecisionById(hippoRoot, tenantId, id);
    if (!decision) {
      console.error(`Decision ${id} not found.`);
      process.exit(1);
    }
    console.log(`Decision #${decision.id}`);
    console.log(`  status: ${decision.status}`);
    console.log(`  text: ${decision.decisionText}`);
    if (decision.context) console.log(`  context: ${decision.context}`);
    if (decision.supersededBy !== null) console.log(`  superseded_by: #${decision.supersededBy}`);
    if (decision.supersededAt) console.log(`  superseded_at: ${decision.supersededAt}`);
    if (decision.closedAt) console.log(`  closed_at: ${decision.closedAt}`);
    if (decision.memoryId) console.log(`  memory: ${decision.memoryId}`);
    console.log(`  created: ${decision.createdAt}`);
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo decide close <id>');
      process.exit(1);
    }
    const id = parseInt(String(idRaw), 10);
    if (!Number.isFinite(id) || id <= 0) {
      console.error(`Invalid decision id: "${idRaw}"`);
      process.exit(1);
    }
    const closed = decisionsModule.closeDecision(hippoRoot, tenantId, id);
    console.log(`Decision #${closed.id} closed.`);
    return;
  }

  // Default subcommand: create. args[0] is the decision text.
  const decisionText = subcommand;
  if (!decisionText) {
    console.error('Usage: hippo decide "<decision>" [--context "<why>"] [--supersedes <memory-id>]');
    console.error('       hippo decide list [--status active|superseded|closed|all] [--limit N]');
    console.error('       hippo decide get <id>');
    console.error('       hippo decide close <id>');
    process.exit(1);
  }
  const contextRaw = flags['context'];
  const context = typeof contextRaw === 'string' && contextRaw ? contextRaw : undefined;
  // A value-less `--supersedes` (parseArgs stores boolean true) is a malformed
  // request: the user asked to supersede but gave no memory id. Reject it rather
  // than silently creating a non-superseding decision (codex review 2026-05-28).
  if (flags['supersedes'] === true) {
    console.error('--supersedes requires a memory id, e.g. hippo decide "<text>" --supersedes mem_abc123.');
    process.exit(1);
  }
  const supersedesMemId = typeof flags['supersedes'] === 'string' ? flags['supersedes'] : null;

  // Backward-compat: --supersedes takes a MEMORY id. Validate it exists and
  // resolve it to the active decision row (if any). Grill fix: commit the
  // canonical table create+supersede FIRST (inside saveDecision's SAVEPOINT),
  // weaken the old memory LAST (best-effort) so a memory-write failure cannot
  // leave the memory stale without the table reflecting the supersession.
  let supersedesDecisionId: number | undefined;
  let oldEntry: MemoryEntry | null = null;
  if (supersedesMemId) {
    oldEntry = readEntry(hippoRoot, supersedesMemId, tenantId) ?? null;
    if (!oldEntry) {
      console.error(`Memory ${supersedesMemId} not found.`);
      process.exit(1);
    }
    supersedesDecisionId =
      decisionsModule.resolveActiveDecisionIdByMemory(hippoRoot, tenantId, supersedesMemId) ?? undefined;
  }

  const decisionPathTags = extractPathTags(process.cwd());
  const created = decisionsModule.saveDecision(hippoRoot, tenantId, {
    decisionText,
    context,
    supersedesDecisionId,
    extraTags: decisionPathTags,
  });

  // Legacy memory-weaken (best-effort, LAST): half-life halved, marked stale +
  // 'superseded' tag. Preserves the exact pre-promotion behavior for the memory
  // mirror; the canonical table supersession already committed above.
  if (oldEntry) {
    // Best-effort: saveDecision already committed the canonical mutation (new
    // decision created + old row superseded). If this legacy memory-weaken
    // throws, do NOT fail the command — a retry would find no active decision
    // for the old memory and create a duplicate active successor. Warn instead
    // (codex review 2026-05-28).
    try {
      oldEntry.half_life_days = Math.max(1, Math.floor(oldEntry.half_life_days / 2));
      oldEntry.confidence = 'stale';
      if (!oldEntry.tags.includes('superseded')) oldEntry.tags.push('superseded');
      writeEntry(hippoRoot, oldEntry);
    } catch (e) {
      console.error(`  warning: decision recorded and superseded, but failed to weaken the prior memory ${supersedesMemId}: ${(e as Error).message}`);
    }
  }

  console.log(`Decision recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (supersedesMemId) {
    const tail =
      supersedesDecisionId !== undefined
        ? ` (decision #${supersedesDecisionId} superseded)`
        : ' (no active decision row; memory weakened only)';
    console.log(`  supersedes memory: ${supersedesMemId}${tail}`);
  }
}

// Strict positive-integer parse for incident id args. parseInt() alone accepts
// trailing junk ("1abc" -> 1), which would let a mutating subcommand (close/
// resolve) silently hit the wrong row; require the whole arg to be digits.
// (codex P2, 2026-05-29.)
function parsePositiveIncidentId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    console.error(`Invalid incident id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function cmdIncident(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = incidentsModule.loadIncidents(hippoRoot, tenantId, { limit });
    } else {
      if (!incidentsModule.VALID_INCIDENT_STATES.has(status as incidentsModule.IncidentStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: open | resolved | closed | all.`);
        process.exit(1);
      }
      results = incidentsModule.loadIncidents(hippoRoot, tenantId, {
        status: status as incidentsModule.IncidentStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No incidents.');
      return;
    }
    console.log(`Found ${results.length} incidents:\n`);
    for (const inc of results) {
      const linkPart = inc.linkedMemoryIds.length > 0 ? ` links=${inc.linkedMemoryIds.length}` : '';
      console.log(`#${inc.id} [${inc.status}]${linkPart} memory=${inc.memoryId ?? '-'}`);
      console.log(`    ${inc.incidentText}`);
      if (inc.context) console.log(`    context: ${inc.context}`);
    }
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo incident get <id>');
      process.exit(1);
    }
    const id = parsePositiveIncidentId(idRaw);
    const incident = incidentsModule.loadIncidentById(hippoRoot, tenantId, id);
    if (!incident) {
      console.error(`Incident ${id} not found.`);
      process.exit(1);
    }
    console.log(`Incident #${incident.id}`);
    console.log(`  status: ${incident.status}`);
    console.log(`  text: ${incident.incidentText}`);
    if (incident.context) console.log(`  context: ${incident.context}`);
    if (incident.resolutionText) console.log(`  resolution: ${incident.resolutionText}`);
    if (incident.resolvedAt) console.log(`  resolved_at: ${incident.resolvedAt}`);
    if (incident.closedAt) console.log(`  closed_at: ${incident.closedAt}`);
    if (incident.linkedMemoryIds.length > 0) {
      console.log(`  linked memories: ${incident.linkedMemoryIds.join(', ')}`);
    }
    if (incident.memoryId) console.log(`  memory: ${incident.memoryId}`);
    console.log(`  created: ${incident.createdAt}`);
    return;
  }

  if (subcommand === 'resolve') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo incident resolve <id> --resolution "<text>"');
      process.exit(1);
    }
    const id = parsePositiveIncidentId(idRaw);
    const resolutionRaw = flags['resolution'];
    if (typeof resolutionRaw !== 'string' || !resolutionRaw.trim()) {
      console.error('--resolution requires a non-empty value, e.g. hippo incident resolve <id> --resolution "root cause fixed".');
      process.exit(1);
    }
    const resolved = incidentsModule.resolveIncident(hippoRoot, tenantId, id, resolutionRaw);
    console.log(`Incident #${resolved.id} resolved.`);
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo incident close <id>');
      process.exit(1);
    }
    const id = parsePositiveIncidentId(idRaw);
    const closed = incidentsModule.closeIncident(hippoRoot, tenantId, id);
    console.log(`Incident #${closed.id} closed.`);
    return;
  }

  // Default subcommand: open (create). Accept both the documented
  // `incident open "<text>"` form and the bare `incident "<text>"` form: for the
  // `open` keyword the text is args[1], otherwise args[0] IS the text.
  const incidentText = subcommand === 'open' ? (args[1] ?? '') : subcommand;
  if (!incidentText) {
    console.error('Usage: hippo incident "<incident>" [--context "<details>"] [--link <memory-id>]...');
    console.error('       hippo incident list [--status open|resolved|closed|all] [--limit N]');
    console.error('       hippo incident get <id>');
    console.error('       hippo incident resolve <id> --resolution "<text>"');
    console.error('       hippo incident close <id>');
    process.exit(1);
  }
  const contextRaw = flags['context'];
  const context = typeof contextRaw === 'string' && contextRaw ? contextRaw : undefined;
  // --link is a repeatable flag (collected into an array by parseArgs). A
  // single --link <id> yields a string; normalize both to string[].
  const linkRaw = flags['link'];
  let linkedMemoryIds: string[] | undefined;
  if (Array.isArray(linkRaw)) {
    linkedMemoryIds = linkRaw;
  } else if (typeof linkRaw === 'string') {
    linkedMemoryIds = [linkRaw];
  } else if (linkRaw === true) {
    console.error('--link requires a memory id, e.g. hippo incident "<text>" --link mem_abc123.');
    process.exit(1);
  }

  const incidentPathTags = extractPathTags(process.cwd());
  const created = incidentsModule.saveIncident(hippoRoot, tenantId, {
    incidentText,
    context,
    linkedMemoryIds,
    extraTags: incidentPathTags,
  });

  console.log(`Incident recorded: #${created.id}`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  if (created.linkedMemoryIds.length > 0) {
    console.log(`  linked memories: ${created.linkedMemoryIds.join(', ')}`);
  }
}

// Strict positive-integer id parse for the mutating process subcommands.
// parseInt alone accepts trailing junk ('1abc' -> 1), which would let
// `process close 1abc` / `supersede 1abc` silently hit the wrong row; require
// the whole arg to be digits. (Mirrors parsePositiveIncidentId; codex P2,
// 2026-05-29.)
function parsePositiveProcessId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    console.error(`Invalid process id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

// --step is a repeatable flag (collected into an array by parseArgs). A single
// --step yields a string; normalize both to string[]. A value-less --step errors.
function collectProcessSteps(stepRaw: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(stepRaw)) return stepRaw;
  if (typeof stepRaw === 'string') return [stepRaw];
  if (stepRaw === true) {
    console.error('--step requires a value, e.g. hippo process new "<name>" --step "do X".');
    process.exit(1);
  }
  return [];
}

function cmdProcess(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = processesModule.loadProcesses(hippoRoot, tenantId, { limit });
    } else {
      if (!processesModule.VALID_PROCESS_STATES.has(status as processesModule.ProcessStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      results = processesModule.loadProcesses(hippoRoot, tenantId, {
        status: status as processesModule.ProcessStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No processes.');
      return;
    }
    console.log(`Found ${results.length} processes:\n`);
    for (const proc of results) {
      console.log(`#${proc.id} [${proc.status}] v${proc.version} steps=${proc.steps.length} memory=${proc.memoryId ?? '-'}`);
      console.log(`    ${proc.processName}`);
      if (proc.changeSummary) console.log(`    change: ${proc.changeSummary}`);
    }
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo process get <id>');
      process.exit(1);
    }
    const id = parsePositiveProcessId(idRaw);
    const proc = processesModule.loadProcessById(hippoRoot, tenantId, id);
    if (!proc) {
      console.error(`Process ${id} not found.`);
      process.exit(1);
    }
    console.log(`Process #${proc.id}`);
    console.log(`  name: ${proc.processName}`);
    console.log(`  status: ${proc.status}`);
    console.log(`  version: ${proc.version}`);
    if (proc.description) console.log(`  description: ${proc.description}`);
    if (proc.steps.length > 0) {
      console.log(`  steps:`);
      proc.steps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
    }
    if (proc.changeSummary) console.log(`  change_summary: ${proc.changeSummary}`);
    if (proc.supersededBy !== null) console.log(`  superseded_by: #${proc.supersededBy}`);
    if (proc.supersededAt) console.log(`  superseded_at: ${proc.supersededAt}`);
    if (proc.closedAt) console.log(`  closed_at: ${proc.closedAt}`);
    if (proc.memoryId) console.log(`  memory: ${proc.memoryId}`);
    console.log(`  created: ${proc.createdAt}`);
    return;
  }

  if (subcommand === 'supersede') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo process supersede <id> --step "<text>" [--step ...] [--change "<summary>"] [--description "<text>"]');
      process.exit(1);
    }
    const id = parsePositiveProcessId(idRaw);
    const steps = collectProcessSteps(flags['step']);
    if (steps.length === 0) {
      console.error('hippo process supersede requires at least one --step "<text>" for the new version.');
      process.exit(1);
    }
    // A supersession is a new version of the SAME process, so the new row reuses
    // the predecessor's name (stable identity across versions). loadProcessById
    // gives an early not-found before the write; saveProcess's in-SAVEPOINT
    // preflight is the authoritative active-state check.
    const existing = processesModule.loadProcessById(hippoRoot, tenantId, id);
    if (!existing) {
      console.error(`Process ${id} not found.`);
      process.exit(1);
    }
    const changeRaw = flags['change'];
    const changeSummary = typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined;
    const descRaw = flags['description'];
    const description = typeof descRaw === 'string' && descRaw ? descRaw : undefined;
    const procPathTags = extractPathTags(process.cwd());
    const created = processesModule.saveProcess(hippoRoot, tenantId, {
      processName: existing.processName,
      steps,
      description,
      changeSummary,
      supersedesProcessId: id,
      extraTags: procPathTags,
    });
    console.log(`Process #${created.id} recorded (v${created.version}), superseding #${id}.`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo process close <id>');
      process.exit(1);
    }
    const id = parsePositiveProcessId(idRaw);
    const closed = processesModule.closeProcess(hippoRoot, tenantId, id);
    console.log(`Process #${closed.id} closed.`);
    return;
  }

  // Default subcommand: new (create). Accept both the documented
  // `process new "<name>"` form and the bare `process "<name>"` form: for the
  // `new` keyword the name is args[1], otherwise args[0] IS the name.
  const processName = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  if (!processName) {
    console.error('Usage: hippo process new "<name>" --step "<text>" [--step ...] [--description "<text>"]');
    console.error('       hippo process list [--status active|superseded|closed|all] [--limit N]');
    console.error('       hippo process get <id>');
    console.error('       hippo process supersede <id> --step "<text>" [--change "<summary>"]');
    console.error('       hippo process close <id>');
    process.exit(1);
  }
  const steps = collectProcessSteps(flags['step']);
  const descRaw = flags['description'];
  const description = typeof descRaw === 'string' && descRaw ? descRaw : undefined;
  const procPathTags = extractPathTags(process.cwd());
  const created = processesModule.saveProcess(hippoRoot, tenantId, {
    processName,
    steps,
    description,
    extraTags: procPathTags,
  });
  console.log(`Process recorded: #${created.id} (v${created.version}, ${created.steps.length} steps)`);
  if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
}

// Strict positive-integer id parse for the mutating policy subcommands (mirrors
// parsePositiveProcessId; codex P2 class - parseInt alone accepts '1abc' -> 1).
function parsePositivePolicyId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    console.error(`Invalid policy id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function printPolicyRow(p: policiesModule.Policy): void {
  const range = p.validTo ? `${p.validFrom}..${p.validTo}` : `${p.validFrom}..(open)`;
  console.log(`#${p.id} [${p.status}] v${p.version} ${range} memory=${p.memoryId ?? '-'}`);
  console.log(`    ${p.policyName}: ${p.policyText}`);
  if (p.changeSummary) console.log(`    change: ${p.changeSummary}`);
}

function cmdPolicy(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = policiesModule.loadPolicies(hippoRoot, tenantId, { limit });
    } else {
      if (!policiesModule.VALID_POLICY_STATES.has(status as policiesModule.PolicyStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      results = policiesModule.loadPolicies(hippoRoot, tenantId, {
        status: status as policiesModule.PolicyStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No policies.');
      return;
    }
    console.log(`Found ${results.length} policies:\n`);
    for (const p of results) printPolicyRow(p);
    return;
  }

  if (subcommand === 'asof') {
    const dateRaw = args[1];
    if (!dateRaw) {
      console.error('Usage: hippo policy asof <iso-date> [--name "<policy>"]');
      process.exit(1);
    }
    const nameRaw = flags['name'];
    const name = typeof nameRaw === 'string' && nameRaw ? nameRaw : undefined;
    let results;
    try {
      results = policiesModule.loadPoliciesAsOf(hippoRoot, tenantId, dateRaw, { name });
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    if (results.length === 0) {
      console.log(`No active policies in force at ${dateRaw}${name ? ` for "${name}"` : ''}.`);
      return;
    }
    console.log(`Policies in force at ${dateRaw}:\n`);
    for (const p of results) printPolicyRow(p);
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo policy get <id>');
      process.exit(1);
    }
    const id = parsePositivePolicyId(idRaw);
    const p = policiesModule.loadPolicyById(hippoRoot, tenantId, id);
    if (!p) {
      console.error(`Policy ${id} not found.`);
      process.exit(1);
    }
    console.log(`Policy #${p.id}`);
    console.log(`  name: ${p.policyName}`);
    console.log(`  text: ${p.policyText}`);
    console.log(`  status: ${p.status}`);
    console.log(`  version: ${p.version}`);
    console.log(`  valid_from: ${p.validFrom}`);
    console.log(`  valid_to: ${p.validTo ?? '(open-ended)'}`);
    if (p.changeSummary) console.log(`  change_summary: ${p.changeSummary}`);
    if (p.supersededBy !== null) console.log(`  superseded_by: #${p.supersededBy}`);
    if (p.supersededAt) console.log(`  superseded_at: ${p.supersededAt}`);
    if (p.closedAt) console.log(`  closed_at: ${p.closedAt}`);
    if (p.memoryId) console.log(`  memory: ${p.memoryId}`);
    console.log(`  created: ${p.createdAt}`);
    return;
  }

  if (subcommand === 'supersede') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo policy supersede <id> --text "<rule>" [--from <iso>] [--to <iso>] [--change "<summary>"]');
      process.exit(1);
    }
    const id = parsePositivePolicyId(idRaw);
    const textRaw = flags['text'];
    if (typeof textRaw !== 'string' || !textRaw.trim()) {
      console.error('hippo policy supersede requires --text "<rule>" for the new version.');
      process.exit(1);
    }
    const existing = policiesModule.loadPolicyById(hippoRoot, tenantId, id);
    if (!existing) {
      console.error(`Policy ${id} not found.`);
      process.exit(1);
    }
    const fromRaw = flags['from'];
    const toRaw = flags['to'];
    const changeRaw = flags['change'];
    try {
      const created = policiesModule.savePolicy(hippoRoot, tenantId, {
        policyName: existing.policyName,
        policyText: textRaw,
        validFrom: typeof fromRaw === 'string' && fromRaw ? fromRaw : undefined,
        validTo: typeof toRaw === 'string' && toRaw ? toRaw : undefined,
        changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
        supersedesPolicyId: id,
        extraTags: extractPathTags(process.cwd()),
      });
      console.log(`Policy #${created.id} recorded (v${created.version}), superseding #${id}.`);
      if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo policy close <id>');
      process.exit(1);
    }
    const id = parsePositivePolicyId(idRaw);
    const closed = policiesModule.closePolicy(hippoRoot, tenantId, id);
    console.log(`Policy #${closed.id} closed.`);
    return;
  }

  // Default subcommand: new (create). Accept both `policy new "<name>"` and the
  // bare `policy "<name>"` form: for the `new` keyword the name is args[1].
  const policyName = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const textRaw = flags['text'];
  if (!policyName || typeof textRaw !== 'string' || !textRaw.trim()) {
    console.error('Usage: hippo policy new "<name>" --text "<rule>" [--from <iso>] [--to <iso>]');
    console.error('       hippo policy list [--status active|superseded|closed|all] [--limit N]');
    console.error('       hippo policy get <id>');
    console.error('       hippo policy asof <iso-date> [--name "<policy>"]');
    console.error('       hippo policy supersede <id> --text "<rule>" [--from] [--to] [--change "<summary>"]');
    console.error('       hippo policy close <id>');
    process.exit(1);
  }
  const fromRaw = flags['from'];
  const toRaw = flags['to'];
  try {
    const created = policiesModule.savePolicy(hippoRoot, tenantId, {
      policyName,
      policyText: textRaw,
      validFrom: typeof fromRaw === 'string' && fromRaw ? fromRaw : undefined,
      validTo: typeof toRaw === 'string' && toRaw ? toRaw : undefined,
      extraTags: extractPathTags(process.cwd()),
    });
    const range = created.validTo ? `${created.validFrom}..${created.validTo}` : `${created.validFrom}..(open)`;
    console.log(`Policy recorded: #${created.id} (v${created.version}, effective ${range})`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

// Strict positive-integer id parse for the mutating skill subcommands (mirrors
// parsePositivePolicyId; codex P2 class - parseInt accepts '1abc' -> 1).
function parsePositiveSkillId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    console.error(`Invalid skill id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function printSkillRow(s: skillsModule.Skill): void {
  const trig = s.trigger ? ` when="${s.trigger}"` : '';
  console.log(`#${s.id} [${s.status}] v${s.version}${trig} memory=${s.memoryId ?? '-'}`);
  console.log(`    ${s.skillName}`);
  if (s.changeSummary) console.log(`    change: ${s.changeSummary}`);
}

function cmdSkill(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    let results;
    if (status === 'all') {
      results = skillsModule.loadSkills(hippoRoot, tenantId, { limit });
    } else {
      if (!skillsModule.VALID_SKILL_STATES.has(status as skillsModule.SkillStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      results = skillsModule.loadSkills(hippoRoot, tenantId, {
        status: status as skillsModule.SkillStatus,
        limit,
      });
    }
    if (results.length === 0) {
      console.log('No skills.');
      return;
    }
    console.log(`Found ${results.length} skills:\n`);
    for (const s of results) printSkillRow(s);
    return;
  }

  if (subcommand === 'export') {
    const md = skillsModule.exportSkills(hippoRoot, tenantId);
    if (!md) {
      console.log('No active skills.');
      return;
    }
    console.log(md);
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo skill get <id>');
      process.exit(1);
    }
    const id = parsePositiveSkillId(idRaw);
    const s = skillsModule.loadSkillById(hippoRoot, tenantId, id);
    if (!s) {
      console.error(`Skill ${id} not found.`);
      process.exit(1);
    }
    console.log(`Skill #${s.id}`);
    console.log(`  name: ${s.skillName}`);
    console.log(`  status: ${s.status}`);
    console.log(`  version: ${s.version}`);
    if (s.trigger) console.log(`  when: ${s.trigger}`);
    console.log(`  instructions: ${s.instructions}`);
    if (s.changeSummary) console.log(`  change_summary: ${s.changeSummary}`);
    if (s.supersededBy !== null) console.log(`  superseded_by: #${s.supersededBy}`);
    if (s.supersededAt) console.log(`  superseded_at: ${s.supersededAt}`);
    if (s.closedAt) console.log(`  closed_at: ${s.closedAt}`);
    if (s.memoryId) console.log(`  memory: ${s.memoryId}`);
    console.log(`  created: ${s.createdAt}`);
    return;
  }

  if (subcommand === 'supersede') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo skill supersede <id> --instructions "<text>" [--trigger "<when>"] [--change "<summary>"]');
      process.exit(1);
    }
    const id = parsePositiveSkillId(idRaw);
    const instrRaw = flags['instructions'];
    if (typeof instrRaw !== 'string' || !instrRaw.trim()) {
      console.error('hippo skill supersede requires --instructions "<text>" for the new version.');
      process.exit(1);
    }
    const existing = skillsModule.loadSkillById(hippoRoot, tenantId, id);
    if (!existing) {
      console.error(`Skill ${id} not found.`);
      process.exit(1);
    }
    const trigRaw = flags['trigger'];
    const changeRaw = flags['change'];
    try {
      const created = skillsModule.saveSkill(hippoRoot, tenantId, {
        skillName: existing.skillName,
        instructions: instrRaw,
        trigger: typeof trigRaw === 'string' && trigRaw ? trigRaw : undefined,
        changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
        supersedesSkillId: id,
        extraTags: extractPathTags(process.cwd()),
      });
      console.log(`Skill #${created.id} recorded (v${created.version}), superseding #${id}.`);
      if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo skill close <id>');
      process.exit(1);
    }
    const id = parsePositiveSkillId(idRaw);
    const closed = skillsModule.closeSkill(hippoRoot, tenantId, id);
    console.log(`Skill #${closed.id} closed.`);
    return;
  }

  // Default subcommand: new (create). Accept both `skill new "<name>"` and the
  // bare `skill "<name>"` form: for the `new` keyword the name is args[1].
  const skillName = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const instrRaw = flags['instructions'];
  if (!skillName || typeof instrRaw !== 'string' || !instrRaw.trim()) {
    console.error('Usage: hippo skill new "<name>" --instructions "<text>" [--trigger "<when>"]');
    console.error('       hippo skill list [--status active|superseded|closed|all] [--limit N]');
    console.error('       hippo skill get <id>');
    console.error('       hippo skill export   (render active skills as an AGENTS.md/CLAUDE.md block)');
    console.error('       hippo skill supersede <id> --instructions "<text>" [--trigger] [--change "<summary>"]');
    console.error('       hippo skill close <id>');
    process.exit(1);
  }
  const trigRaw = flags['trigger'];
  try {
    const created = skillsModule.saveSkill(hippoRoot, tenantId, {
      skillName,
      instructions: instrRaw,
      trigger: typeof trigRaw === 'string' && trigRaw ? trigRaw : undefined,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Skill recorded: #${created.id} (v${created.version})`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

function parsePositiveBriefId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    console.error(`Invalid brief id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function printBriefRow(b: briefsModule.ProjectBrief): void {
  console.log(`#${b.id} [${b.status}] v${b.version} repo="${b.repo}" memory=${b.memoryId ?? '-'}`);
  if (b.changeSummary) console.log(`    change: ${b.changeSummary}`);
}

function briefUsage(): void {
  console.error('Usage: hippo brief new "<repo>" --summary "<text>"');
  console.error('       hippo brief list [--status active|superseded|closed|all] [--repo "<repo>"] [--limit N]');
  console.error('       hippo brief get <id>');
  console.error('       hippo brief supersede <id> --summary "<text>" [--change "<summary>"]');
  console.error('       hippo brief close <id>');
  console.error('       hippo brief refresh "<repo>" [--dry-run]   (auto-assemble the brief from the repo\'s receipts)');
}

function cmdProjectBrief(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const repoRaw = flags['repo'];
    const repo = typeof repoRaw === 'string' && repoRaw.trim() ? repoRaw.trim() : undefined;
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    const opts: briefsModule.ListProjectBriefsOpts = { limit, repo };
    if (status !== 'all') {
      if (!briefsModule.VALID_BRIEF_STATES.has(status as briefsModule.BriefStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      opts.status = status as briefsModule.BriefStatus;
    }
    const results = briefsModule.loadProjectBriefs(hippoRoot, tenantId, opts);
    if (results.length === 0) {
      console.log('No project briefs.');
      return;
    }
    console.log(`Found ${results.length} project briefs:\n`);
    for (const b of results) printBriefRow(b);
    return;
  }

  if (subcommand === 'refresh') {
    const repoRaw = args[1];
    if (!repoRaw) {
      console.error('Usage: hippo brief refresh "<repo>" [--dry-run]');
      process.exit(1);
    }
    const dryRun = Boolean(flags['dry-run']);
    try {
      if (dryRun) {
        const { markdown, receiptCount } = briefsModule.assembleBriefFromReceipts(hippoRoot, tenantId, repoRaw);
        console.error(`(dry-run: assembled from ${receiptCount} receipt(s); brief NOT written)`);
        console.log(markdown);
        return;
      }
      const created = briefsModule.refreshBrief(hippoRoot, tenantId, repoRaw, 'cli');
      console.log(`Project brief #${created.id} recorded (v${created.version}) for repo "${created.repo}".`);
      if (created.changeSummary) console.log(`  change: ${created.changeSummary}`);
      if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo brief get <id>');
      process.exit(1);
    }
    const id = parsePositiveBriefId(idRaw);
    const b = briefsModule.loadProjectBriefById(hippoRoot, tenantId, id);
    if (!b) {
      console.error(`Project brief ${id} not found.`);
      process.exit(1);
    }
    console.log(`Project brief #${b.id}`);
    console.log(`  repo: ${b.repo}`);
    console.log(`  status: ${b.status}`);
    console.log(`  version: ${b.version}`);
    console.log(`  summary: ${b.summary}`);
    if (b.changeSummary) console.log(`  change_summary: ${b.changeSummary}`);
    if (b.supersededBy !== null) console.log(`  superseded_by: #${b.supersededBy}`);
    if (b.supersededAt) console.log(`  superseded_at: ${b.supersededAt}`);
    if (b.closedAt) console.log(`  closed_at: ${b.closedAt}`);
    if (b.memoryId) console.log(`  memory: ${b.memoryId}`);
    console.log(`  created: ${b.createdAt}`);
    return;
  }

  if (subcommand === 'supersede') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo brief supersede <id> --summary "<text>" [--change "<summary>"]');
      process.exit(1);
    }
    const id = parsePositiveBriefId(idRaw);
    const summaryRaw = flags['summary'];
    if (typeof summaryRaw !== 'string' || !summaryRaw.trim()) {
      console.error('hippo brief supersede requires --summary "<text>" for the new version.');
      process.exit(1);
    }
    const existing = briefsModule.loadProjectBriefById(hippoRoot, tenantId, id);
    if (!existing) {
      console.error(`Project brief ${id} not found.`);
      process.exit(1);
    }
    const changeRaw = flags['change'];
    try {
      const created = briefsModule.saveProjectBrief(hippoRoot, tenantId, {
        repo: existing.repo,
        summary: summaryRaw,
        changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
        supersedesBriefId: id,
        extraTags: extractPathTags(process.cwd()),
      });
      console.log(`Project brief #${created.id} recorded (v${created.version}), superseding #${id}.`);
      if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo brief close <id>');
      process.exit(1);
    }
    const id = parsePositiveBriefId(idRaw);
    const closed = briefsModule.closeProjectBrief(hippoRoot, tenantId, id);
    console.log(`Project brief #${closed.id} closed.`);
    return;
  }

  // Default subcommand: new (create). Accept both `brief new "<repo>"` and the
  // bare `brief "<repo>"` form: for the `new` keyword the repo is args[1].
  const repo = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const summaryRaw = flags['summary'];
  if (!repo || typeof summaryRaw !== 'string' || !summaryRaw.trim()) {
    briefUsage();
    process.exit(1);
  }
  try {
    const created = briefsModule.saveProjectBrief(hippoRoot, tenantId, {
      repo,
      summary: summaryRaw,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Project brief recorded: #${created.id} (v${created.version}) for repo "${created.repo}"`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

function parsePositiveNoteId(idRaw: unknown): number {
  const s = String(idRaw ?? '').trim();
  const id = parseInt(s, 10);
  if (!/^\d+$/.test(s) || id <= 0) {
    console.error(`Invalid note id: "${idRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  return id;
}

function printNoteRow(n: customerNotesModule.CustomerNote): void {
  console.log(`#${n.id} [${n.status}] v${n.version} customer="${n.customer}" memory=${n.memoryId ?? '-'}`);
  if (n.changeSummary) console.log(`    change: ${n.changeSummary}`);
}

function noteUsage(): void {
  console.error('Usage: hippo note new "<customer>" --text "<note>"');
  console.error('       hippo note list [--status active|superseded|closed|all] [--customer "<id>"] [--limit N]');
  console.error('       hippo note get <id>');
  console.error('       hippo note supersede <id> --text "<note>" [--change "<summary>"]');
  console.error('       hippo note close <id>');
}

function cmdGraph(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'extract') {
    const result = extractGraph(hippoRoot, tenantId);
    const byType = Object.entries(result.byType)
      .map(([t, n]) => `${t} ${n}`)
      .join(', ');
    const supersedes = result.relations - result.references;
    console.log(`Graph extracted: ${result.entities} entities (${byType}) + ${result.relations} relations (${supersedes} supersedes, ${result.references} references).`);
    if (result.truncated.length > 0) {
      console.error(`WARNING: under-extracted (hit the per-type cap): ${result.truncated.join(', ')}. The graph is incomplete for those types.`);
    }
    return;
  }

  const entity = typeof flags['entity'] === 'string' ? (flags['entity'] as string) : undefined;

  if (subcommand === 'show') {
    const model = buildGraphModel(hippoRoot, tenantId, { entity, limit: DEFAULT_VIEW_LIMIT });
    if (flags['json']) {
      console.log(JSON.stringify(model, null, 2));
      return;
    }
    if (model.nodes.length === 0) {
      console.log(entity ? `No entity named "${entity}".` : 'Graph is empty. Run `hippo graph extract` first.');
      return;
    }
    console.log(`Graph: ${model.nodes.length} entities, ${model.edges.length} relations${model.truncated ? ' (truncated)' : ''}`);
    const byType = new Map<string, { id: number; name: string }[]>();
    for (const n of model.nodes) {
      const arr = byType.get(n.type) ?? [];
      arr.push({ id: n.id, name: n.name });
      byType.set(n.type, arr);
    }
    for (const [type, ns] of byType) {
      console.log(`\n${type} (${ns.length}):`);
      for (const n of ns) console.log(`  [${n.id}] ${n.name}`);
    }
    if (model.edges.length > 0) {
      const nameById = new Map(model.nodes.map((n) => [n.id, n.name]));
      console.log('\nrelations:');
      for (const e of model.edges) {
        console.log(`  ${nameById.get(e.from)} --${e.relType}--> ${nameById.get(e.to)}`);
      }
    }
    return;
  }

  if (subcommand === 'view') {
    const format = typeof flags['format'] === 'string' ? (flags['format'] as string) : 'html';
    if (format !== 'html' && format !== 'canvas') {
      console.error("graph view: --format must be 'html' or 'canvas'");
      process.exit(1);
    }
    const model = buildGraphModel(hippoRoot, tenantId, { entity, limit: DEFAULT_VIEW_LIMIT });
    const content = format === 'canvas' ? renderGraphCanvas(model) : renderGraphHtml(model);
    const defaultOut = format === 'canvas' ? 'hippo-graph.canvas' : 'hippo-graph.html';
    const out = typeof flags['out'] === 'string' ? (flags['out'] as string) : defaultOut;
    fs.writeFileSync(out, content, 'utf8');
    console.log(`Wrote ${model.nodes.length} entities + ${model.edges.length} relations to ${out}${model.truncated ? ' (truncated)' : ''}`);
    if (flags['open'] && format === 'html') {
      // Best-effort browser launch; never fail the command if it doesn't work.
      try {
        const [cmd, cmdArgs] =
          process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '', out]]
            : process.platform === 'darwin'
              ? ['open', [out]]
              : ['xdg-open', [out]];
        const child = spawn(cmd, cmdArgs as string[], { detached: true, stdio: 'ignore' });
        // A missing launcher (e.g. xdg-open absent) emits 'error' asynchronously;
        // an unhandled 'error' event would throw, so swallow it — the file is
        // already written and its path printed above.
        child.on('error', () => { /* best-effort launch */ });
        child.unref();
      } catch {
        /* ignore — the file is written; the path is printed above */
      }
    }
    return;
  }

  console.error(
    'Usage:\n' +
      '  hippo graph extract                     Rebuild the entity/relation graph from consolidated objects\n' +
      '  hippo graph show [--entity NAME] [--json]   Inspect entities + their edges (text or JSON)\n' +
      '  hippo graph view [--out FILE] [--open] [--format html|canvas] [--entity NAME]   Generate an interactive node-link diagram',
  );
  process.exit(1);
}

function cmdCustomerNote(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (subcommand === 'list') {
    const statusRaw = flags['status'];
    const status = typeof statusRaw === 'string' ? statusRaw.trim() : 'all';
    const customerRaw = flags['customer'];
    const customer = typeof customerRaw === 'string' && customerRaw.trim() ? customerRaw.trim() : undefined;
    const limitRaw = flags['limit'];
    const limit = limitRaw !== undefined ? parseInt(String(limitRaw), 10) : 100;
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error(`Invalid --limit: "${limitRaw}". Must be a positive integer.`);
      process.exit(1);
    }
    const opts: customerNotesModule.ListCustomerNotesOpts = { limit, customer };
    if (status !== 'all') {
      if (!customerNotesModule.VALID_NOTE_STATES.has(status as customerNotesModule.NoteStatus)) {
        console.error(`Invalid --status: "${status}". Must be one of: active | superseded | closed | all.`);
        process.exit(1);
      }
      opts.status = status as customerNotesModule.NoteStatus;
    }
    const results = customerNotesModule.loadCustomerNotes(hippoRoot, tenantId, opts);
    if (results.length === 0) {
      console.log('No customer notes.');
      return;
    }
    console.log(`Found ${results.length} customer notes:\n`);
    for (const n of results) printNoteRow(n);
    return;
  }

  if (subcommand === 'get') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo note get <id>');
      process.exit(1);
    }
    const id = parsePositiveNoteId(idRaw);
    const n = customerNotesModule.loadCustomerNoteById(hippoRoot, tenantId, id);
    if (!n) {
      console.error(`Customer note ${id} not found.`);
      process.exit(1);
    }
    console.log(`Customer note #${n.id}`);
    console.log(`  customer: ${n.customer}`);
    console.log(`  status: ${n.status}`);
    console.log(`  version: ${n.version}`);
    console.log(`  note: ${n.note}`);
    if (n.changeSummary) console.log(`  change_summary: ${n.changeSummary}`);
    if (n.supersededBy !== null) console.log(`  superseded_by: #${n.supersededBy}`);
    if (n.supersededAt) console.log(`  superseded_at: ${n.supersededAt}`);
    if (n.closedAt) console.log(`  closed_at: ${n.closedAt}`);
    if (n.memoryId) console.log(`  memory: ${n.memoryId}`);
    console.log(`  created: ${n.createdAt}`);
    return;
  }

  if (subcommand === 'supersede') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo note supersede <id> --text "<note>" [--change "<summary>"]');
      process.exit(1);
    }
    const id = parsePositiveNoteId(idRaw);
    const textRaw = flags['text'];
    if (typeof textRaw !== 'string' || !textRaw.trim()) {
      console.error('hippo note supersede requires --text "<note>" for the new version.');
      process.exit(1);
    }
    const existing = customerNotesModule.loadCustomerNoteById(hippoRoot, tenantId, id);
    if (!existing) {
      console.error(`Customer note ${id} not found.`);
      process.exit(1);
    }
    const changeRaw = flags['change'];
    try {
      const created = customerNotesModule.saveCustomerNote(hippoRoot, tenantId, {
        customer: existing.customer,
        note: textRaw,
        changeSummary: typeof changeRaw === 'string' && changeRaw ? changeRaw : undefined,
        supersedesNoteId: id,
        extraTags: extractPathTags(process.cwd()),
      });
      console.log(`Customer note #${created.id} recorded (v${created.version}), superseding #${id}.`);
      if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'close') {
    const idRaw = args[1];
    if (!idRaw) {
      console.error('Usage: hippo note close <id>');
      process.exit(1);
    }
    const id = parsePositiveNoteId(idRaw);
    const closed = customerNotesModule.closeCustomerNote(hippoRoot, tenantId, id);
    console.log(`Customer note #${closed.id} closed.`);
    return;
  }

  // Default subcommand: new (create). Accept both `note new "<customer>"` and the
  // bare `note "<customer>"` form: for the `new` keyword the customer is args[1].
  const customer = subcommand === 'new' ? (args[1] ?? '') : subcommand;
  const textRaw = flags['text'];
  if (!customer || typeof textRaw !== 'string' || !textRaw.trim()) {
    noteUsage();
    process.exit(1);
  }
  try {
    const created = customerNotesModule.saveCustomerNote(hippoRoot, tenantId, {
      customer,
      note: textRaw,
      extraTags: extractPathTags(process.cwd()),
    });
    console.log(`Customer note recorded: #${created.id} (v${created.version}) for customer "${created.customer}"`);
    if (created.memoryId) console.log(`  memory: ${created.memoryId}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

function cmdCurrent(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'show') {
    const asJson = Boolean(flags['json']);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
    const sessionId = snapshot?.session_id ?? undefined;
    const events = listSessionEvents(hippoRoot, resolveTenantId({}), {
      session_id: sessionId,
      limit: 5,
    });

    if (asJson) {
      console.log(JSON.stringify({
        snapshot: snapshot ?? null,
        events: events.map((ev) => ({
          id: ev.id,
          session_id: ev.session_id,
          event_type: ev.event_type,
          content: ev.content,
          created_at: ev.created_at,
        })),
      }));
      return;
    }

    if (!snapshot && events.length === 0) {
      console.log('No active task or recent session events.');
      return;
    }

    console.log('# Current State\n');

    if (snapshot) {
      console.log(`Task: ${snapshot.task}`);
      console.log(`Status: ${snapshot.status} | Source: ${snapshot.source} | Updated: ${snapshot.updated_at}`);
      if (snapshot.session_id) {
        console.log(`Session: ${snapshot.session_id}`);
      }
      console.log(`Summary: ${snapshot.summary}`);
      console.log(`Next: ${snapshot.next_step}`);
    } else {
      console.log('No active task snapshot.');
    }

    if (events.length > 0) {
      console.log('');
      console.log('Recent events:');
      for (const ev of events) {
        const ts = ev.created_at.slice(0, 19).replace('T', ' ');
        console.log(`  [${ts}] (${ev.event_type}) ${ev.content}`);
      }
    }

    return;
  }

  console.error('Usage: hippo current <show>');
  process.exit(1);
}

async function cmdContext(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  // --pinned-only fires on every UserPromptSubmit — including in directories
  // that don't have a local .hippo. Skip requireInit for that path and fall
  // back to global-only inside api.getContext. The non-pinned path still
  // requires init (handled by CLI for user-friendly error messaging).
  const pinnedOnly = flags['pinned-only'] === true;
  if (!pinnedOnly) {
    requireInit(hippoRoot);
  }

  const budget = parseInt(String(flags['budget'] ?? '1500'), 10);
  if (budget <= 0) return;

  // Resolve query: explicit args, --auto (git diff via CLI-side helper), or
  // fall through to api.getContext's '*' fallback. api.getContext is host-
  // agnostic so the auto-detect (which shells out to git) stays CLI-side.
  let query = args.join(' ').trim();
  if (!query && flags['auto']) {
    query = autoDetectContext();
  }

  // Scope detection (CLI-side: uses cwd). api.getContext takes the resolved
  // scope via opts.scope to stay host-agnostic.
  const ctxExplicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const ctxActiveScope = ctxExplicitScope || detectScope();

  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const opts: api.ContextOpts = {
    q: query,
    budget,
    limit: parseLimitFlag(flags['limit']),
    pinnedOnly,
    scope: ctxActiveScope ?? undefined,
    includeRecent: parseCountFlag(flags['include-recent']),
  };

  const result = await api.getContext(ctx, opts);

  // Early exit when there's nothing to render (matches pre-extraction behavior).
  const hasContextData =
    result.entries.length > 0 ||
    result.activeSnapshot ||
    result.sessionHandoff ||
    (result.recentEvents && result.recentEvents.length > 0);
  if (!hasContextData) return;

  // Format + framing are CLI rendering concerns; api.getContext doesn't see them.
  const format = String(flags['format'] ?? 'markdown');
  const framing = String(flags['framing'] ?? 'observe');

  // Adapter: ContextResultEntry -> the print-helper input shape.
  const renderItems = result.entries.map((r) => ({
    entry: r.entry,
    score: r.score,
    tokens: r.tokens,
    isGlobal: r.isGlobal ?? false,
  }));

  if (format === 'json') {
    const output = result.entries.map((r) => ({
      id: r.entry.id,
      score: r.score,
      strength: r.entry.strength,
      tags: r.entry.tags,
      confidence: r.entry.confidence,
      content: r.entry.content,
      global: r.isGlobal ?? false,
    }));
    console.log(JSON.stringify({
      query: query || '*',
      activeSnapshot: result.activeSnapshot ?? null,
      sessionHandoff: result.sessionHandoff ?? null,
      recentSessionEvents: result.recentEvents ?? [],
      memories: output,
      tokens: result.tokens,
    }));
  } else if (format === 'additional-context') {
    // Claude Code UserPromptSubmit hook JSON shape. Capture print* helpers'
    // output into a string buffer and wrap as `additionalContext`.
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
    try {
      if (result.activeSnapshot) printActiveTaskSnapshot(result.activeSnapshot);
      if (result.sessionHandoff) printHandoff(result.sessionHandoff);
      if (result.recentEvents && result.recentEvents.length > 0) {
        printSessionEvents(result.recentEvents);
      }
      if (renderItems.length > 0) {
        printContextMarkdown(renderItems, result.tokens, framing);
      }
    } finally {
      console.log = realLog;
    }
    const textBlock = lines.join('\n');
    if (!textBlock.trim()) return;
    const payload = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: textBlock,
      },
    };
    process.stdout.write(JSON.stringify(payload));
  } else {
    // markdown (default)
    if (result.activeSnapshot) {
      printActiveTaskSnapshot(result.activeSnapshot);
    }
    if (result.sessionHandoff) {
      printHandoff(result.sessionHandoff);
    }
    if (result.recentEvents && result.recentEvents.length > 0) {
      printSessionEvents(result.recentEvents);
    }
    if (renderItems.length > 0) {
      printContextMarkdown(renderItems, result.tokens, framing);
    }

    // Ambient state summary (CLI-side: api.getContext doesn't load all entries
    // post-selection, so we re-load here for the landscape summary).
    const ambientConfig = loadConfig(hippoRoot);
    if (ambientConfig.ambient.enabled && !pinnedOnly) {
      const tenantId = ctx.tenantId;
      const globalRoot = getGlobalRoot();
      const hasGlobalForAmbient = isInitialized(globalRoot);
      const localForAmbient = isInitialized(hippoRoot)
        ? loadAllEntries(hippoRoot, tenantId).filter(e => !e.superseded_by)
        : [];
      const globalForAmbient = hasGlobalForAmbient
        ? loadAllEntries(globalRoot, tenantId).filter(e => !e.superseded_by)
        : [];
      const allForAmbient = [...localForAmbient, ...globalForAmbient];
      if (allForAmbient.length > 0) {
        const ambientState = computeAmbientState(allForAmbient);
        console.log(`\n${renderAmbientSummary(ambientState)}`);
      }
    }
  }
}

/** @internal — exported for snapshot tests (tests/cli-context-render-snapshot.test.ts). NOT a stable public API. */
export function printContextMarkdown(
  items: Array<{ entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean }>,
  totalTokens: number,
  framing: string = 'observe'
): void {
  const now = new Date();
  console.log(`## Project Memory (${items.length} entries, ${totalTokens} tokens)\n`);
  for (const item of items) {
    const e = item.entry;
    const tagStr = e.tags.length > 0 ? ` [${e.tags.join(', ')}]` : '';
    const strengthPct = Math.round(calculateStrength(e) * 100);
    const globalPrefix = item.isGlobal ? '[global] ' : '';
    const effectiveConf = resolveConfidence(e, now);
    const confWarning = (effectiveConf === 'stale' || effectiveConf === 'inferred') ? ' \u26A0\uFE0F' : '';
    const confTag = `[${effectiveConf}]${confWarning}`;

    if (framing === 'observe') {
      const dateStr = new Date(e.created).toISOString().slice(0, 10);
      if (effectiveConf === 'verified') {
        // Verified: no date prefix, just the rule
        console.log(`- **${confTag} ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
      } else if (effectiveConf === 'stale') {
        console.log(`- **${confTag} Previously observed (${dateStr}): ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
      } else {
        console.log(`- **${confTag} Previously observed (${dateStr}): ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
      }
    } else if (framing === 'suggest') {
      console.log(`- **${confTag} Consider checking: ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
    } else {
      // framing === 'assert': no prefix (bare facts)
      console.log(`- **${confTag} ${globalPrefix}${e.content}**${tagStr} (${strengthPct}%)`);
    }
  }
}

function autoDetectContext(): string {
  // Try git diff --name-only for changed files
  try {
    const diff = execSync('git diff --name-only HEAD 2>&1', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    if (diff) {
      // Extract meaningful terms from file paths
      const terms = diff
        .split('\n')
        .flatMap((f: string) => f.replace(/[\/\\\.]/g, ' ').split(/\s+/))
        .filter((t: string) => t.length > 2 && !['src', 'dist', 'test', 'tests', 'node_modules', 'index'].includes(t))
        .slice(0, 10);
      if (terms.length > 0) return terms.join(' ');
    }

    // Try branch name
    const branch = execSync('git branch --show-current 2>&1', {
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    if (branch && branch !== 'main' && branch !== 'master') {
      return branch.replace(/[-_\/]/g, ' ');
    }
  } catch {
    // Not a git repo or git not available, fall through
  }

  return '';
}

// ---------------------------------------------------------------------------
// Embed command
// ---------------------------------------------------------------------------

async function cmdEmbed(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  requireInit(hippoRoot);

  // --status and --reset-physics only read cached state, so they must work even
  // when no provider key is present (e.g. embedded earlier with a key that was
  // later removed). The provider-availability gate is deferred to the embed path.
  if (flags['reset-physics']) {
    const entries = loadAllEntries(hippoRoot);
    const embIndex = loadEmbeddingIndex(hippoRoot);
    const db = openHippoDb(hippoRoot);
    try {
      const count = resetAllPhysicsState(db, entries, embIndex);
      console.log(`Reset physics state: ${count} particles re-initialized from embeddings.`);
    } finally {
      closeHippoDb(db);
    }
    return;
  }

  if (flags['status']) {
    const entries = loadAllEntries(hippoRoot);
    const embIndex = loadEmbeddingIndex(hippoRoot);
    const activeIds = new Set(entries.map((e) => e.id));
    const activeEmbedded = Object.keys(embIndex).filter((id) => activeIds.has(id)).length;
    const orphaned = Object.keys(embIndex).length - activeEmbedded;
    console.log(`Embedding status: ${activeEmbedded}/${entries.length} memories embedded`);
    if (orphaned > 0) {
      console.log(`  ${orphaned} orphaned embeddings (run \`hippo embed\` to prune)`);
    }
    const missing = entries.filter((e) => !embIndex[e.id]);
    if (missing.length > 0) {
      console.log(`  ${missing.length} memories need embedding (run \`hippo embed\` to embed them)`);
    }
    return;
  }

  // Embedding (unlike status/reset) needs an available provider.
  const embedProvider = (() => {
    try {
      return resolveEmbeddingProvider(hippoRoot);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return null;
    }
  })();
  if (!embedProvider) {
    process.exitCode = 1;
    return;
  }
  if (!embedProvider.isAvailable()) {
    if (loadConfig(hippoRoot).embeddings.enabled === false) {
      console.log('Embeddings are disabled in config (embeddings.enabled = false). Set it to true or "auto" to enable.');
      return;
    }
    if (embedProvider.kind === 'local') {
      console.log('Embeddings not available. Install @xenova/transformers to enable:');
      console.log('  npm install @xenova/transformers');
    } else {
      console.error(
        `Embedding provider '${embedProvider.kind}' is configured but ${embedProvider.keyEnv} is not set.`,
      );
      console.error(`Export ${embedProvider.keyEnv}, or set config.embeddings.provider back to 'local'.`);
      process.exitCode = 1;
    }
    return;
  }

  console.log('Embedding all memories (this may take a moment on first run to download model)...');
  let count: number;
  try {
    count = await embedAll(hippoRoot, resolveEmbeddingModel(hippoRoot));
  } catch (err) {
    console.error(`Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    const partial = loadEmbeddingIndex(hippoRoot);
    console.error(
      `Partial progress saved: ${Object.keys(partial).length} embeddings on disk. Re-run \`hippo embed\` to resume.`,
    );
    process.exitCode = 1;
    return;
  }
  const entriesAfter = loadAllEntries(hippoRoot);
  const embIndexAfter = loadEmbeddingIndex(hippoRoot);
  console.log(`Done. ${count} new embeddings created. ${Object.keys(embIndexAfter).length}/${entriesAfter.length} total.`);
}

// ---------------------------------------------------------------------------
// Watch command
// ---------------------------------------------------------------------------

async function cmdWatch(command: string, hippoRoot: string): Promise<void> {
  if (!command) {
    console.error('Usage: hippo watch "<command>"');
    process.exit(1);
  }

  const { exitCode, stderr } = await runWatched(command);

  if (exitCode === 0) {
    // Success: no noise
    return;
  }

  // Only create memory if hippo is initialized
  if (!isInitialized(hippoRoot)) {
    console.error('Command failed but .hippo not initialized. Run `hippo init` to enable auto-learn.');
    process.exit(exitCode);
  }

  const entry = captureError(exitCode, stderr, command);
  // Compute schema fit against existing memories
  const existingWatch = loadAllEntries(hippoRoot);
  const watchFit = computeSchemaFit(entry.content, entry.tags, existingWatch);
  entry.schema_fit = watchFit;
  entry.half_life_days = deriveHalfLife(7, entry);
  entry.strength = calculateStrength(entry);
  writeEntry(hippoRoot, entry);
  updateStats(hippoRoot, { remembered: 1 });

  if (isEmbeddingConfigured(hippoRoot)) {
    embedMemory(hippoRoot, entry).catch(() => {});
  }

  const preview = stderr.trim().slice(0, 80);
  console.error(`\nHippo learned from failure: "${preview}"`);

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Learn command
// ---------------------------------------------------------------------------

function learnFromRepo(
  hippoRoot: string,
  repoPath: string,
  days: number,
  label?: string
): { added: number; skipped: number } {
  const prefix = label ? `[${label}] ` : '';

  if (!isGitRepo(repoPath)) {
    console.log(`${prefix}No git history found (or not a git repository).`);
    return { added: 0, skipped: 0 };
  }

  const gitLog = fetchGitLog(repoPath, days);
  if (!gitLog.trim()) {
    console.log(`${prefix}No fix/revert/bug commits found in the specified period.`);
    return { added: 0, skipped: 0 };
  }

  const lessons = extractLessons(gitLog);
  if (lessons.length === 0) {
    console.log(`${prefix}No fix/revert/bug commits found in the specified period.`);
    return { added: 0, skipped: 0 };
  }

  let added = 0;
  let skipped = 0;
  const gitLearnTags = ['error', 'git-learned'];
  const existingForSchema = loadAllEntries(hippoRoot);

  for (const lesson of lessons) {
    // L9: learnFromRepo's existingForSchema load just above (the
    // `loadAllEntries(hippoRoot)` call a few lines up) is host-wide and
    // intentionally out-of-L9-scope per plan §11 (cli.ts is
    // single-tenant-per-process). The tenantId arg here is a defensive no-op:
    // deduplicateLesson's array overload ignores it; the parameter exists
    // only to mirror the canonical caller pattern used elsewhere in cli.ts.
    if (deduplicateLesson(existingForSchema, lesson, 0.7, resolveTenantId({}))) {
      skipped++;
      continue;
    }

    const target = extractInvalidationTarget(lesson);
    if (target) {
      const invResult = invalidateMatching(hippoRoot, target, resolveTenantId({}));
      if (invResult.invalidated > 0) {
        console.log(`${prefix}   Invalidated ${invResult.invalidated} memories referencing "${target.from}"`);
      }
    }

    const schemaFitVal = computeSchemaFit(lesson, gitLearnTags, existingForSchema);

    const entry = createMemory(lesson, {
      layer: Layer.Episodic,
      tags: [...gitLearnTags],
      source: 'git-learn',
      confidence: 'observed',
      schema_fit: schemaFitVal,
    });

    // Auto-tag with path context from the repo being learned
    const learnPathTags = extractPathTags(repoPath);
    for (const pt of learnPathTags) {
      if (!entry.tags.includes(pt)) entry.tags.push(pt);
    }

    writeEntry(hippoRoot, entry);
    updateStats(hippoRoot, { remembered: 1 });

    if (isEmbeddingConfigured(hippoRoot)) {
      embedMemory(hippoRoot, entry).catch(() => {});
    }

    added++;
  }

  console.log(`${prefix}${added} new lessons added, ${skipped} duplicates skipped.`);
  return { added, skipped };
}

function cmdLearn(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  if (!flags['git']) {
    console.error('Usage: hippo learn --git [--days <n>] [--repos <paths>]');
    process.exit(1);
  }

  const days = parseInt(String(flags['days'] ?? '7'), 10);

  console.log(`Scanning git log for the last ${days} days...`);

  const reposFlag = flags['repos'];
  if (reposFlag && typeof reposFlag === 'string') {
    const repos = reposFlag.split(',').map((r) => r.trim()).filter(Boolean);
    let totalAdded = 0;
    let totalSkipped = 0;

    for (const repo of repos) {
      const label = path.basename(repo);
      const { added, skipped } = learnFromRepo(hippoRoot, repo, days, label);
      totalAdded += added;
      totalSkipped += skipped;
    }

    console.log(`Git learn complete: ${totalAdded} new lessons added, ${totalSkipped} duplicates skipped across ${repos.length} repos.`);
  } else {
    const { added, skipped } = learnFromRepo(hippoRoot, process.cwd(), days);
    console.log(`Git learn complete: ${added} new lessons added, ${skipped} duplicates skipped.`);
  }
}

// ---------------------------------------------------------------------------
// Import command
// ---------------------------------------------------------------------------

function cmdImport(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  const useGlobal = Boolean(flags['global']);
  const dryRun = Boolean(flags['dry-run']);
  const extraTags: string[] = Array.isArray(flags['tag'])
    ? (flags['tag'] as string[])
    : flags['tag']
      ? [String(flags['tag'])]
      : [];

  const targetRoot = useGlobal ? getGlobalRoot() : hippoRoot;

  if (useGlobal) {
    initGlobal();
  } else {
    requireInit(hippoRoot);
  }

  const importOptions: ImportOptions = {
    dryRun,
    global: useGlobal,
    extraTags,
    hippoRoot,
  };

  // K1 vault import: a FOLDER importer that mirrors the connector pattern
  // (kind='raw' + tag provenance + archiveRaw deletions), so it dispatches
  // separately from the single-file `importer` function-pointer slot below.
  // It writes through api.remember/archiveRaw which are tenant-scoped, so we
  // resolve the tenant and pass it through. --global is not supported for
  // vault import (the connector raw-archive path is tenant-local).
  if (flags['vault']) {
    const folderPath = String(flags['vault']);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      console.error(`Vault folder not found (or not a directory): ${folderPath}`);
      process.exit(1);
    }
    if (useGlobal) {
      console.error('hippo import --vault does not support --global (raw rows are tenant-local).');
      process.exit(1);
    }
    if (!flags['name'] || !String(flags['name']).trim()) {
      // --name is the vault identity key for the destructive source-deletion sync;
      // inferring it from the folder basename let same-basename vaults collide and
      // clobber each other (codex R10 P2). Require it explicitly.
      console.error('hippo import --vault requires --name <vault> (the identity key used for source-deletion sync).');
      process.exit(1);
    }
    const tenantId = resolveTenantId({});
    const vaultOptions: ImportOptions = {
      ...importOptions,
      tenantId,
      name: flags['name'] ? String(flags['name']) : undefined,
      scope: flags['scope'] ? String(flags['scope']) : undefined,
    };
    const vaultResult = importVault(folderPath, vaultOptions);
    console.log(`\nImport Vault: ${folderPath}${dryRun ? ' (dry run - no writes)' : ''}`);
    console.log(`  Notes found:           ${vaultResult.total}`);
    console.log(`  ${dryRun ? 'Would import:         ' : 'Imported:             '}${vaultResult.imported}`);
    console.log(`  Skipped (unchanged):   ${vaultResult.skipped}`);
    console.log(`  ${dryRun ? 'Would archive:        ' : 'Archived (removed):   '}${vaultResult.archived ?? 0}`);
    console.log(`  Store:                 ${hippoRoot}`);
    return;
  }

  // Determine which importer to use based on flag
  let filePath: string | undefined;
  let importer: ((fp: string, opts: ImportOptions) => ReturnType<typeof importChatGPT>) | undefined;
  let importerName = '';

  if (flags['chatgpt']) {
    filePath = String(flags['chatgpt']);
    importer = importChatGPT;
    importerName = 'ChatGPT';
  } else if (flags['claude']) {
    filePath = String(flags['claude']);
    importer = importClaude;
    importerName = 'Claude';
  } else if (flags['cursor']) {
    filePath = String(flags['cursor']);
    importer = importCursor;
    importerName = 'Cursor';
  } else if (flags['file']) {
    filePath = String(flags['file']);
    importer = importGenericFile;
    importerName = 'File';
  } else if (flags['markdown']) {
    filePath = String(flags['markdown']);
    importer = importMarkdown;
    importerName = 'Markdown';
  } else if (args[0]) {
    // Positional: try to auto-detect from extension
    filePath = args[0];
    importer = importGenericFile;
    importerName = 'File';
  }

  if (!filePath || !importer) {
    console.error('Usage: hippo import <--chatgpt|--claude|--cursor|--file|--markdown|--vault> <path>');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = importer(filePath, importOptions);

  const storeLabel = useGlobal ? `global (${getGlobalRoot()})` : targetRoot;

  console.log(`\nImport ${importerName}: ${filePath}`);
  console.log(`  Source entries found:  ${result.total}`);
  console.log(`  Imported:              ${result.imported}`);
  console.log(`  Skipped (dedup/noise): ${result.skipped}`);
  if (dryRun) {
    console.log('\n  (dry run - nothing written)');
    if (result.entries.length > 0) {
      console.log('\n  Would import:');
      for (const e of result.entries.slice(0, 10)) {
        console.log(`    - ${e.content.slice(0, 80)}`);
      }
      if (result.entries.length > 10) {
        console.log(`    ... and ${result.entries.length - 10} more`);
      }
    }
  } else {
    console.log(`  Store:                 ${storeLabel}`);
  }
}

// ---------------------------------------------------------------------------
// Promote command
// ---------------------------------------------------------------------------

function cmdPromote(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  if (!id) {
    console.error('Usage: hippo promote <id>');
    process.exit(1);
  }

  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  try {
    const result = api.promote(ctx, id);
    console.log(`Promoted ${id} to global store as ${result.globalId}`);
    console.log(`   Global store: ${getGlobalRoot()}`);
  } catch (err) {
    console.error(`Failed to promote: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Sync command
// ---------------------------------------------------------------------------

function cmdSync(hippoRoot: string): void {
  requireInit(hippoRoot);

  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  const count = syncGlobalToLocal(hippoRoot, globalRoot);
  console.log(`Synced ${count} global memories into local project.`);
}

// ---------------------------------------------------------------------------
// Hook install/uninstall
// ---------------------------------------------------------------------------

const HOOK_MARKERS = {
  start: '<!-- hippo:start -->',
  end: '<!-- hippo:end -->',
};

const HOOKS: Record<string, { file: string; content: string; description: string }> = {
  'claude-code': {
    file: 'CLAUDE.md',
    description: 'Claude Code',
    content: `
## Project Memory (Hippo)

Pinned rules and recent writes auto-inject at every prompt via the installed
UserPromptSubmit hook; never re-run that part manually. At the START of a
task (not per prompt), additionally load task-specific context: git-aware
recall over the full store that per-prompt injection does not cover. Also
run it if the hook is not installed:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`

When you learn something important:
\`\`\`bash
hippo remember "<lesson>"
\`\`\`

When you hit an error or discover a gotcha:
\`\`\`bash
hippo remember "<what went wrong and why>" --error
\`\`\`

After completing work successfully:
\`\`\`bash
hippo outcome --good
\`\`\`

When the user ends the session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons — 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'codex': {
    file: 'AGENTS.md',
    description: 'OpenAI Codex',
    content: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

When Hippo's Codex wrapper is installed, session-end capture runs automatically.
If the wrapper is not installed, capture a brief summary manually:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons — 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'cursor': {
    file: '.cursorrules',
    description: 'Cursor',
    content: `
# Project Memory (Hippo)
# Before each task, load context:
#   hippo context --auto --budget 1500
# After errors:
#   hippo remember "<error description>" --error
# After completing:
#   hippo outcome --good
`.trim(),
  },
  'openclaw': {
    file: 'AGENTS.md',
    description: 'OpenClaw',
    content: `
## Project Memory (Hippo)

At the start of every session, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons — 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'opencode': {
    file: 'AGENTS.md',
    description: 'OpenCode',
    content: `
## Project Memory (Hippo)

At the start of every task, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

When you learn something important or hit an error:
\`\`\`bash
hippo remember "<lesson>" --error
\`\`\`

When stuck or repeating yourself, check if this happened before:
\`\`\`bash
hippo recall "<what's going wrong>" --budget 2000
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons — 2-5 bullets>'
\`\`\`
`.trim(),
  },
  'pi': {
    file: 'AGENTS.md',
    description: 'Pi',
    content: `
## Project Memory (Hippo)

At the start of every session, run:
\`\`\`bash
hippo context --auto --budget 1500
\`\`\`
Read the output before writing any code.

On errors or unexpected behaviour:
\`\`\`bash
hippo remember "<description of what went wrong>" --error
\`\`\`

On task completion:
\`\`\`bash
hippo outcome --good
\`\`\`

When ending a session, capture a brief summary:
\`\`\`bash
hippo capture --stdin <<< '<decisions, errors, lessons — 2-5 bullets>'
\`\`\`

For full integration, copy the hippo-memory Pi extension to \`~/.pi/agent/extensions/hippo-memory/\`.
`.trim(),
  },
};

function cmdHook(
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  const subcommand = args[0];
  const target = args[1];

  if (subcommand === 'list') {
    console.log('Available hooks:\n');
    for (const [name, hook] of Object.entries(HOOKS)) {
      console.log(`  ${name.padEnd(15)} -> ${hook.file} (${hook.description})`);
    }
    console.log('\nUsage: hippo hook install <name>');
    console.log('       hippo hook uninstall <name>');
    return;
  }

  if (subcommand === 'install') {
    if (!target || !HOOKS[target]) {
      console.error(`Unknown hook target: ${target ?? '(none)'}`);
      console.error(`   Available: ${Object.keys(HOOKS).join(', ')}`);
      process.exit(1);
    }

    const hook = HOOKS[target];
    const filepath = path.resolve(process.cwd(), hook.file);

    const block = `${HOOK_MARKERS.start}\n${hook.content}\n${HOOK_MARKERS.end}`;
    let agentFileTouched = false;

    if (fs.existsSync(filepath)) {
      const existing = fs.readFileSync(filepath, 'utf8');

      if (existing.includes(HOOK_MARKERS.start)) {
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
      agentFileTouched = true;
    } else {
      // Do not create a new agent-instructions file (CLAUDE.md, AGENTS.md, etc.)
      // in directories that don't already have one — avoids polluting cwd with
      // files the user didn't ask for. The settings.json hook below is still
      // installed for claude-code, so the consolidation hook still runs.
      console.log(
        `${hook.file} not found in ${process.cwd()} — skipping agent-instructions patch.`,
      );
      console.log(`   Create ${hook.file} and re-run \`hippo hook install ${target}\` if you want the agent prompt.`);
    }

    // For Claude Code, also install SessionEnd+SessionStart entries in its
    // settings file.
    if (target === 'claude-code') {
      const result = installJsonHooks(target);
      if (result.installedSessionEnd) {
        console.log(`Installed hippo session-end SessionEnd hook in ${result.target} settings`);
      }
      if (result.installedSessionStart) {
        console.log(`Installed hippo last-sleep SessionStart hook in ${result.target} settings`);
      }
      if (result.installedUserPromptSubmit) {
        console.log(`Installed hippo pinned-inject UserPromptSubmit hook in ${result.target} settings`);
      }
      if (result.migratedFromStop) {
        console.log(`Migrated legacy Stop hook → SessionEnd (was running every turn; now fires once on session exit)`);
      }
      if (result.migratedSplitSessionEnd) {
        console.log(`Migrated split sleep+capture SessionEnd entries → single detached hippo session-end`);
      } else if (result.migratedLegacySessionEnd) {
        console.log(`Migrated legacy SessionEnd entry to the new detached form`);
      }
    } else if (target === 'opencode') {
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
    } else if (target === 'codex') {
      const result = installCodexWrapper();
      console.log(`Installed Codex session-end integration -> ${result.metadataPath}`);
      console.log(`   Wrapped detected Codex launcher at ${result.commandPath}`);
    }

    return;
  }

  if (subcommand === 'uninstall') {
    if (!target || !HOOKS[target]) {
      console.error(`Unknown hook target: ${target ?? '(none)'}`);
      process.exit(1);
    }

    const hook = HOOKS[target];
    const filepath = path.resolve(process.cwd(), hook.file);

    if (fs.existsSync(filepath)) {
      const existing = fs.readFileSync(filepath, 'utf8');
      if (existing.includes(HOOK_MARKERS.start)) {
        const re = new RegExp(
          `\\n?${escapeRegex(HOOK_MARKERS.start)}[\\s\\S]*?${escapeRegex(HOOK_MARKERS.end)}\\n?`,
          'g'
        );
        const cleaned = existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
        fs.writeFileSync(filepath, cleaned + '\n', 'utf8');
        console.log(`Removed Hippo hook from ${hook.file}`);
      } else {
        console.log(`No Hippo hook found in ${hook.file}.`);
      }
    } else {
      console.log(`${hook.file} not found, skipping agent-instructions uninstall.`);
    }

    // For Claude Code, also strip its SessionEnd/SessionStart entries.
    if (target === 'claude-code') {
      if (uninstallJsonHooks(target)) {
        console.log(`Removed hippo hooks from ${target} settings`);
      }
    } else if (target === 'opencode') {
      // opencode uses a TS plugin; uninstall removes the plugin file AND
      // also runs the legacy-hooks migration so the downgrade/remove path
      // leaves opencode launchable.
      if (uninstallOpencodePlugin()) {
        console.log(`Removed hippo opencode plugin (and any legacy hooks block from opencode.json)`);
      }
    } else if (target === 'codex') {
      if (uninstallCodexWrapper()) {
        console.log('Removed Codex wrapper integration');
      }
    }

    return;
  }

  console.error('Usage: hippo hook <install|uninstall|list> [target]');
  process.exit(1);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `hippo setup` -- one-shot configuration for every AI coding tool on the box.
// Detection and install logic live in ./hooks.ts.

function cmdSetup(flags: Record<string, string | boolean | string[]>): void {
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
    console.log('No JSON-hook-capable tools detected (checked: claude-code).');
    console.log('Run with --all to install hooks anyway.');
  }

  for (const tool of jsonTools) {
    if (dryRun) {
      // Resolve the real settings path so the filename is right for each tool
      // (claude-code -> settings.json, opencode -> opencode.json).
      const { settings } = resolveJsonHookPaths(tool.name as JsonHookTarget);
      console.log(`[dry-run] would install hooks in ${settings}`);
      continue;
    }
    const result = installJsonHooks(tool.name as JsonHookTarget);
    const bits: string[] = [];
    if (result.installedSessionEnd) bits.push('SessionEnd (session-end)');
    if (result.installedSessionStart) bits.push('SessionStart');
    if (result.installedUserPromptSubmit) bits.push('UserPromptSubmit (pinned-inject)');
    if (result.migratedFromStop) bits.push('migrated legacy Stop');
    if (result.migratedSplitSessionEnd) bits.push('migrated split SessionEnd → session-end');
    else if (result.migratedLegacySessionEnd) bits.push('migrated legacy SessionEnd');
    if (bits.length === 0) {
      console.log(`  ${tool.name.padEnd(14)} already configured (${result.settingsPath})`);
    } else {
      console.log(`  ${tool.name.padEnd(14)} ${bits.join(', ')} -> ${result.settingsPath}`);
    }
  }

  for (const tool of skipped) {
    console.log(`  ${tool.name.padEnd(14)} not detected at ${tool.configDir} -- skipping`);
  }

  for (const tool of wrapperTools) {
    if (dryRun) {
      console.log(`[dry-run] would wrap the detected ${tool.name} launcher in place`);
      continue;
    }
    if (tool.name === 'codex') {
      const result = ensureCodexWrapperInstalled();
      if (result.status === 'installed') {
        console.log(`  ${tool.name.padEnd(14)} wrapped launcher -> ${result.commandPath}`);
      } else if (result.status === 'already-installed') {
        console.log(`  ${tool.name.padEnd(14)} already wrapped -> ${result.commandPath}`);
      } else {
        console.log(`  ${tool.name.padEnd(14)} not found on PATH -- skipping`);
      }
    }
  }

  if (pluginTools.length > 0) {
    console.log('');
    console.log('Plugin-based tools (hook API via plugin, not JSON):');
    for (const tool of pluginTools) {
      if (tool.name === 'opencode') {
        if (dryRun) {
          console.log(`  ${tool.name.padEnd(14)} [dry-run] would install hippo plugin at ${resolveOpencodePluginPath()}`);
          continue;
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
      } else {
        // Other plugin tools (openclaw) have their own installer; the notes
        // line points the user at it.
        console.log(`  ${tool.name.padEnd(14)} ${tool.notes}`);
      }
    }
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

  console.log('');
  console.log('Done. Restart your AI tool to activate the hooks.');
}

function cmdDailyRunner(): void {
  const globalRoot = getGlobalRoot();
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
      console.error(`[hippo] daily-runner failed in ${cwd} during \`${action}\`: ${(err as Error).message}`);
    }
  });

  console.log(`Daily maintenance complete: ${processed} workspace${processed === 1 ? '' : 's'} processed, ${failed} command failure${failed === 1 ? '' : 's'}.`);
}

// JSON-hook install/uninstall lives in ./hooks.ts so tests can import it
// without running the CLI main(). Backwards-compatible wrappers below keep
// older call sites working.

function installClaudeCodeSessionEndHook(): { installed: boolean; migratedFromStop: boolean } {
  const result = installJsonHooks('claude-code');
  return {
    installed:
      result.installedSessionEnd ||
      result.installedSessionStart ||
      result.installedUserPromptSubmit,
    migratedFromStop: result.migratedFromStop,
  };
}

function uninstallClaudeCodeSessionEndHook(): boolean {
  return uninstallJsonHooks('claude-code');
}

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------

function cmdWm(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? '';

  if (subcommand === 'push') {
    const scope = String(flags['scope'] ?? 'default').trim();
    const content = String(flags['content'] ?? '').trim();
    const importance = parseFloat(String(flags['importance'] ?? '0.5'));
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;
    const taskId = flags['task'] ? String(flags['task']).trim() : undefined;

    if (!content) {
      console.error('Usage: hippo wm push --scope <scope> --content "..." [--importance 0.8] [--session <id>] [--task <id>]');
      process.exit(1);
    }

    const id = wmPush(hippoRoot, {
      scope,
      content,
      importance: Number.isFinite(importance) ? importance : 0.5,
      sessionId,
      taskId,
    });

    console.log(`Pushed working memory #${id} (scope=${scope}, importance=${Number.isFinite(importance) ? importance : 0.5})`);
    return;
  }

  if (subcommand === 'read') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;
    const limit = parseInt(String(flags['limit'] ?? '20'), 10) || 20;

    const items = wmRead(hippoRoot, { scope, sessionId, limit });

    if (flags['json']) {
      console.log(JSON.stringify({ items }, null, 2));
      return;
    }

    if (items.length === 0) {
      console.log('No working memory entries.');
      return;
    }

    console.log(`Working memory (${items.length} entries):\n`);
    for (const item of items) {
      const sessionLabel = item.sessionId ? ` session=${item.sessionId}` : '';
      const taskLabel = item.taskId ? ` task=${item.taskId}` : '';
      console.log(`  #${item.id} [${item.scope}] importance=${item.importance}${sessionLabel}${taskLabel}`);
      console.log(`    ${item.content}`);
      console.log(`    created=${item.createdAt}`);
      console.log('');
    }
    return;
  }

  if (subcommand === 'clear') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;

    const count = wmClear(hippoRoot, { scope, sessionId });
    console.log(`Cleared ${count} working memory entries.`);
    return;
  }

  if (subcommand === 'flush') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;

    const count = wmFlush(hippoRoot, { scope, sessionId });
    console.log(`Flushed ${count} working memory entries.`);
    return;
  }

  console.error('Usage: hippo wm <push|read|clear|flush>');
  process.exit(1);
}

function cmdDag(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  requireInit(hippoRoot);
  const entries = loadAllEntries(hippoRoot);
  const isStats = flags['stats'] === true;

  const byLevel = new Map<number, number>();
  let unlinked = 0;

  for (const entry of entries) {
    const level = entry.dag_level ?? 0;
    byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
    if (level === 1 && !entry.dag_parent_id) unlinked++;
  }

  if (isStats) {
    console.log('DAG Structure:');
    console.log(`  Level 3 (entity profiles):  ${byLevel.get(3) ?? 0}`);
    console.log(`  Level 2 (topic summaries):  ${byLevel.get(2) ?? 0}`);
    console.log(`  Level 1 (extracted facts):  ${byLevel.get(1) ?? 0}`);
    console.log(`  Level 0 (raw memories):     ${byLevel.get(0) ?? 0}`);
    console.log(`  Unlinked facts: ${unlinked}`);
    return;
  }

  // Tree view: v0.30 / E5 renders L3 entity profiles as roots (with L2
  // children indented), then orphan L2 summaries (no L3 parent) at top
  // level. Pre-E5 behavior was L2-only roots; rendering now covers L3.
  const profiles = entries.filter((e) => e.dag_level === 3);
  const l2List = entries.filter((e) => e.dag_level === 2);
  const orphanL2 = l2List.filter((e) => !e.dag_parent_id);
  const childL2ByProfile = new Map<string, typeof l2List>();
  for (const l2 of l2List) {
    if (!l2.dag_parent_id) continue;
    const list = childL2ByProfile.get(l2.dag_parent_id) ?? [];
    list.push(l2);
    childL2ByProfile.set(l2.dag_parent_id, list);
  }

  if (profiles.length === 0 && orphanL2.length === 0) {
    console.log('No DAG summaries yet. Run `hippo sleep` with ANTHROPIC_API_KEY set.');
    return;
  }

  // L3 entity profiles as tree roots with their L2 children.
  for (const profile of profiles) {
    const profileTags = profile.tags.filter((t) => t !== 'dag-entity-profile').join(', ');
    console.log(`\n🌲 ${profile.content.slice(0, 80)}`);
    if (profileTags) console.log(`   [${profileTags}]`);
    const l2Children = childL2ByProfile.get(profile.id) ?? [];
    for (const l2 of l2Children) {
      const l2Tags = l2.tags.filter((t) => t !== 'dag-summary').join(', ');
      console.log(`   └─ 📌 ${l2.content.slice(0, 70)}`);
      if (l2Tags) console.log(`      [${l2Tags}]`);
      const facts = entries.filter((e) => e.dag_parent_id === l2.id);
      for (const f of facts) {
        console.log(`      └─ ${f.content.slice(0, 60)}`);
      }
    }
  }

  // Orphan L2 summaries (no L3 parent) at top level — pre-E5 default shape.
  for (const summary of orphanL2) {
    const summaryTags = summary.tags.filter((t) => t !== 'dag-summary').join(', ');
    console.log(`\n📌 ${summary.content.slice(0, 80)}`);
    if (summaryTags) console.log(`   [${summaryTags}]`);
    const children = entries.filter((e) => e.dag_parent_id === summary.id);
    for (const child of children) {
      console.log(`   └─ ${child.content.slice(0, 70)}`);
    }
  }
}

function cmdAssemble(hippoRoot: string, sessionId: string, flags: Record<string, string | boolean | string[]>): void {
  requireInit(hippoRoot);
  const budget = typeof flags['budget'] === 'string' ? Number(flags['budget']) : undefined;
  const freshTailCount = typeof flags['fresh-tail'] === 'string' ? Number(flags['fresh-tail']) : undefined;
  const summarizeOlder = flags['no-summarize-older'] !== true;
  const scope = typeof flags['scope'] === 'string' && (flags['scope'] as string).length > 0
    ? (flags['scope'] as string)
    : undefined;
  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli:assemble'),
  };
  const r = api.assemble(ctx, sessionId, {
    ...(Number.isFinite(budget) && budget! > 0 ? { budget } : {}),
    ...(Number.isFinite(freshTailCount) && freshTailCount! >= 0 ? { freshTailCount } : {}),
    summarizeOlder,
    ...(scope !== undefined ? { scope } : {}),
  });
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`Session ${r.sessionId} — ${r.items.length} items, ${r.tokens} tokens (raw=${r.totalRaw}, summarized=${r.summarized}, evicted=${r.evicted})`);
  for (const it of r.items) {
    const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
    const head = it.content.slice(0, 120);
    console.log(`  ${prefix} ${it.createdAt} ${it.id} — ${head}${it.content.length > 120 ? '…' : ''}`);
  }
}

function cmdDrillDown(hippoRoot: string, summaryId: string, flags: Record<string, string | boolean | string[]>): void {
  requireInit(hippoRoot);
  const limit = typeof flags['limit'] === 'string' ? Number(flags['limit']) : undefined;
  const budget = typeof flags['budget'] === 'string' ? Number(flags['budget']) : undefined;
  // v0.30 / E5: --depth N walks N levels down (default 1, hard cap 10).
  // L4 fold: reject out-of-range explicitly (no silent clamp).
  const rawDepth = typeof flags['depth'] === 'string' ? Number(flags['depth']) : undefined;
  let depth: number | undefined;
  if (rawDepth !== undefined) {
    if (!Number.isFinite(rawDepth) || rawDepth < 1 || rawDepth > 10) {
      console.error(`--depth must be an integer between 1 and 10 (got ${flags['depth']})`);
      process.exit(2);
    }
    depth = rawDepth;
  }
  const ctx: api.Context = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli:drill'),
  };
  const r = api.drillDown(ctx, summaryId, {
    ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
    ...(Number.isFinite(budget) && budget! > 0 ? { budget } : {}),
    ...(depth !== undefined ? { depth } : {}),
  });
  if ('failure' in r) {
    // v1.6.4: only `not_drillable` is caller-actionable. `not_found`
    // intentionally collapses cross-tenant + scope-blocked + missing
    // (codex round 3 P1: distinguishing scope_blocked leaked existence).
    if (r.failure === 'not_drillable') {
      console.error(`Id ${summaryId} is a leaf row, not a level-2+ summary; nothing to drill into.`);
    } else {
      console.error(`No drillable summary at id=${summaryId}.`);
    }
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(`Summary ${r.summary.id} — ${r.summary.descendantCount} descendants${r.summary.earliestAt ? ` (${r.summary.earliestAt} → ${r.summary.latestAt})` : ''}`);
  console.log(`  ${r.summary.content.slice(0, 200)}${r.summary.content.length > 200 ? '…' : ''}`);
  console.log(`\nChildren (${r.children.length}/${r.totalChildren}${r.truncated ? ', truncated' : ''}):`);
  for (const c of r.children) {
    console.log(`  [L${c.dagLevel}] ${c.id} — ${c.content.slice(0, 100)}${c.content.length > 100 ? '…' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Auth subcommands (A5 stub auth)
// ---------------------------------------------------------------------------

function resolveAuthRoot(hippoRoot: string, flags: Record<string, string | boolean | string[]>): string {
  if (flags['global']) {
    initGlobal();
    return getGlobalRoot();
  }
  requireInit(hippoRoot);
  return hippoRoot;
}

function cmdAuthCreate(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantFlag = typeof flags['tenant'] === 'string' ? (flags['tenant'] as string) : undefined;
  const labelFlag = typeof flags['label'] === 'string' ? (flags['label'] as string) : undefined;
  const asJson = Boolean(flags['json']);

  // v1.12.3: --role flag surfaces the api_keys.role column added v1.12.0
  // sub-1. Accepts 'admin' | 'member' only; anything else exits 1 with a
  // typed error so a typo doesn't silently default to admin.
  const roleFlag = typeof flags['role'] === 'string' ? (flags['role'] as string) : undefined;
  let role: 'admin' | 'member' = 'admin';
  if (roleFlag !== undefined) {
    if (roleFlag !== 'admin' && roleFlag !== 'member') {
      console.error(`Invalid --role value: '${roleFlag}'. Use 'admin' or 'member'.`);
      process.exit(1);
    }
    role = roleFlag;
  }

  // The CLI's --tenant flag is the only legitimate cross-tenant override
  // (admin minting a key for another tenant from the local machine). It
  // flows through ctx.tenantId, NOT through opts — authCreate's opts no
  // longer accepts a tenantId field, so the HTTP layer cannot smuggle a
  // body.tenantId across.
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: tenantFlag ?? resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const result = api.authCreate(ctx, { label: labelFlag, role });

  if (asJson) {
    console.log(JSON.stringify({
      keyId: result.keyId,
      plaintext: result.plaintext,
      tenantId: result.tenantId,
      label: labelFlag ?? null,
      role: result.role,
    }));
    return;
  }

  console.log(`key_id:    ${result.keyId}`);
  console.log(`plaintext: ${result.plaintext}`);
  console.log(`role:      ${result.role}`);
  console.log('');
  console.log('!! WARNING: this is the ONLY time the plaintext key will be shown. !!');
  console.log('!! Copy it now. Hippo stores only a scrypt hash and cannot recover it. !!');
}

function formatKeyRow(item: ApiKeyListItem): string {
  const label = item.label ?? '-';
  const created = item.createdAt;
  const revoked = item.revokedAt ?? '-';
  // v1.12.3: role column surfaced
  return `${item.keyId}  ${item.tenantId}  ${item.role}  ${label}  ${created}  ${revoked}`;
}

function cmdAuthList(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const includeRevoked = Boolean(flags['all']);
  const asJson = Boolean(flags['json']);

  const db = openHippoDb(root);
  let items: ApiKeyListItem[];
  try {
    items = listApiKeys(db, { active: !includeRevoked });
  } finally {
    closeHippoDb(db);
  }

  if (asJson) {
    console.log(JSON.stringify(items));
    return;
  }

  if (items.length === 0) {
    console.log(includeRevoked ? 'No API keys.' : 'No active API keys. (Use --all to include revoked.)');
    return;
  }

  console.log('key_id  tenant  role  label  created  revoked');
  for (const item of items) {
    console.log(formatKeyRow(item));
  }
}

function cmdAuthRevoke(hippoRoot: string, keyId: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const asJson = Boolean(flags['json']);

  const db = openHippoDb(root);
  let exists = false;
  let alreadyRevoked = false;
  let revokedAt: string | null = null;
  let keyTenantId: string | null = null;
  try {
    const row = db.prepare(`SELECT key_id, tenant_id, revoked_at FROM api_keys WHERE key_id = ?`).get(keyId) as
      | { key_id: string; tenant_id: string; revoked_at: string | null }
      | undefined;
    if (!row) {
      // Let the finally{} block close the db. M4: avoid manual close before
      // process.exit() — the finally already handles it on every path.
      console.error(`Unknown key_id: ${keyId}`);
      process.exit(1);
    }
    exists = true;
    keyTenantId = row.tenant_id;
    if (row.revoked_at) {
      alreadyRevoked = true;
      revokedAt = row.revoked_at;
    } else {
      revokeApiKey(db, keyId);
      const updated = db.prepare(`SELECT revoked_at FROM api_keys WHERE key_id = ?`).get(keyId) as
        | { revoked_at: string | null }
        | undefined;
      revokedAt = updated?.revoked_at ?? null;
    }
    // M1: emit auth_revoke audit event. Skip on no-op revoke (already revoked)
    // so re-running the command doesn't pad the audit log with duplicates.
    if (!alreadyRevoked && keyTenantId) {
      try {
        appendAuditEvent(db, {
          tenantId: keyTenantId,
          actor: 'cli',
          op: 'auth_revoke',
          targetId: keyId,
        });
      } catch {
        // Audit must not crash a successful revoke.
      }
    }
  } finally {
    closeHippoDb(db);
  }

  if (!exists) return;

  if (asJson) {
    console.log(JSON.stringify({ keyId, revokedAt }));
    return;
  }
  console.log(`Revoked ${keyId} at ${revokedAt}`);
}

// ---------------------------------------------------------------------------
// Audit log subcommands (A5 stub auth — `hippo audit list`)
// ---------------------------------------------------------------------------

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>([
  'remember',
  'recall',
  'promote',
  'supersede',
  'forget',
  'archive_raw',
  'auth_revoke',
  'auth_create', // v1.12.4: emitted by api.authCreate
  'outcome',     // v1.11.5: pre-existing drift — emitted today but rejected by old Set
  'consolidate', // v1.11.5: emitted by api.sleep / hippo sleep
  'audit_prune', // v1.12.9: emitted by pruneAuditLog
  'summary_marked_dirty', // v0.30 / E1 — lockstep with AuditOp union + server.ts VALID_AUDIT_OPS (v1.11.5 CRIT A institutional rule)
  'summary_marked_clean', // v0.30 / E3 — buildDag post-link clean op; lockstep
  'summary_rebuilt',      // v0.30 / E3 — sleep-cycle rebuild op; lockstep
  'predict_create',       // v0.31 / E2 prediction first-class object — emitted by savePrediction
  'predict_close',        // v0.31 / E2 — emitted by closePrediction
  'predict_baserate',     // v0.31 / J3 — emitted by computePredictionBaserate
  'recall_autodebias_hint',                   // v0.32 / J3.2 — emitted by computePlanningFallacyHint on success
  'recall_autodebias_hint_no_class_match',    // v0.32 / J3.2 — telemetry: forward-claim, no class scored
  'recall_autodebias_hint_tiebreak',          // v0.32 / J3.2 — telemetry: forward-claim, >=2 classes tied
  'recall_anchor_detected_query_repeat',      // v0.33 / J1 — emitted by detector on R1 fire
  'recall_anchor_detected_memory_dominance',  // v0.33 / J1 — emitted by detector on R2 fire
  'recall_anchor_skipped_no_session',         // v0.33 / J1 — telemetry: no sessionId, ring skipped
  'recall_availability_detected',             // v1.13.x / J2 - emitted when availability/recency-bias hint fires
  'decision_create',       // E2 decision first-class object — emitted by saveDecision
  'decision_supersede',    // E2 — emitted by saveDecision when --supersedes resolves to an active decision row
  'decision_close',        // E2 — emitted by closeDecision
  'incident_open',         // E2 incident first-class object — emitted by saveIncident
  'incident_resolve',      // E2 — emitted by resolveIncident (open -> resolved)
  'incident_close',        // E2 — emitted by closeIncident (open|resolved -> closed)
  'process_create',        // E2 process first-class object — emitted by saveProcess
  'process_supersede',     // E2 — emitted by saveProcess on a supersession
  'process_close',         // E2 — emitted by closeProcess
  'policy_create',         // E2 policy first-class object — emitted by savePolicy
  'policy_supersede',      // E2 — emitted by savePolicy on a supersession
  'policy_close',          // E2 — emitted by closePolicy
  'skill_create',          // E2 skill first-class object — emitted by saveSkill
  'skill_supersede',       // E2 — emitted by saveSkill on a supersession
  'skill_close',           // E2 — emitted by closeSkill
  'project_brief_create',  // E2 project_brief first-class object — emitted by saveProjectBrief
  'project_brief_supersede', // E2 — emitted by saveProjectBrief on a supersession (incl. refresh)
  'project_brief_close',   // E2 — emitted by closeProjectBrief
  'customer_note_create',  // E2 customer_note first-class object — emitted by saveCustomerNote
  'customer_note_supersede', // E2 — emitted by saveCustomerNote on a supersession
  'customer_note_close',   // E2 — emitted by closeCustomerNote
]);

function formatAuditRow(ev: AuditEvent): string {
  const target = ev.targetId ?? '-';
  const meta = JSON.stringify(ev.metadata ?? {});
  return `${ev.ts}  ${ev.actor}  ${ev.op}  ${target}  ${meta}`;
}

function cmdAuditList(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const asJson = Boolean(flags['json']);
  const tenantId = resolveTenantId({});

  const opFlag = typeof flags['op'] === 'string' ? (flags['op'] as string) : undefined;
  if (opFlag && !VALID_AUDIT_OPS.has(opFlag as AuditOp)) {
    // Regenerate from Set to prevent future drift (v1.11.5: pre-v1.11.5 message
    // was hand-maintained and had drifted — missed 'auth_revoke' and 'outcome').
    const expected = Array.from(VALID_AUDIT_OPS).join(' | ');
    console.error(`Unknown --op value: ${opFlag}. Expected one of: ${expected}.`);
    process.exit(1);
  }
  const op = opFlag as AuditOp | undefined;

  const since = typeof flags['since'] === 'string' ? (flags['since'] as string) : undefined;
  if (since !== undefined && !Number.isFinite(new Date(since).getTime())) {
    console.error(`Invalid --since: ${since} (expected an ISO timestamp like 2026-04-22 or 2026-04-22T12:00:00Z).`);
    process.exit(1);
  }

  const limitRaw = flags['limit'];
  let limit = 100;
  if (limitRaw !== undefined && typeof limitRaw !== 'boolean') {
    const parsed = parseInt(String(limitRaw), 10);
    if (!Number.isFinite(parsed)) {
      console.error(`Invalid --limit value: ${String(limitRaw)} (expected a positive integer).`);
      process.exit(1);
    }
    limit = parsed;
  }
  if (limit < 1 || limit > 10000) {
    console.error(`--limit must be between 1 and 10000 (got ${limit}).`);
    process.exit(1);
  }

  const ctx: api.Context = { hippoRoot: root, tenantId, actor: { subject: 'cli', role: 'admin' } };
  const events = api.auditList(ctx, { op, since, limit });

  if (asJson) {
    console.log(JSON.stringify(events));
    return;
  }

  if (events.length === 0) {
    console.log('No audit events.');
    return;
  }

  console.log('ts  actor  op  target_id  metadata');
  for (const ev of events) {
    console.log(formatAuditRow(ev));
  }
}

function printAuditPruneUsage(): void {
  console.log('hippo audit prune --older-than <Nd> [--dry-run] [--tenant <t>]');
  console.log('  --older-than <Nd>  Delete audit_log rows with ts older than N days (e.g. 90d).');
  console.log('  --dry-run          Count matching rows without deleting (operator safety).');
  console.log('  --tenant <t>       Tenant scope. Defaults to HIPPO_TENANT or "default".');
  console.log('  --json             Output the result as JSON {cutoff, count, dryRun}.');
}

function cmdAuditPrune(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  if (flags['help']) {
    printAuditPruneUsage();
    return;
  }
  const olderThanRaw = typeof flags['older-than'] === 'string' ? (flags['older-than'] as string) : '';
  if (!olderThanRaw) {
    console.error('Usage: hippo audit prune --older-than <Nd> [--dry-run] [--tenant <t>]');
    process.exit(1);
  }
  let olderThanDays: number;
  try {
    olderThanDays = parseOlderThanFlag(olderThanRaw);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const tenantId = typeof flags['tenant'] === 'string'
    ? (flags['tenant'] as string).trim() || resolveTenantId({})
    : resolveTenantId({});
  const dryRun = flags['dry-run'] === true;
  const asJson = Boolean(flags['json']);

  const db = openHippoDb(hippoRoot);
  let result;
  try {
    result = pruneAuditLog(db, { olderThanDays, tenantId, dryRun, actor: 'cli' });
  } finally {
    closeHippoDb(db);
  }

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }
  const verb = dryRun ? 'would delete' : 'deleted';
  console.log(`audit prune: ${verb} ${result.count} row${result.count === 1 ? '' : 's'} for tenant "${tenantId}" with ts < ${result.cutoff}`);
  if (dryRun) {
    console.log('(dry-run; re-run without --dry-run to actually delete)');
  }
}

function cmdAuditLog(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (sub === 'list') {
    cmdAuditList(hippoRoot, flags);
    return;
  }
  if (sub === 'prune') {
    cmdAuditPrune(hippoRoot, flags);
    return;
  }
  console.error(`Unknown audit subcommand: ${sub}. Expected: list | prune.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// `hippo goal <push|list|complete|suspend|resume>` — B3 dlPFC depth (Task 10)
// ---------------------------------------------------------------------------

const GOAL_POLICY_TYPES: ReadonlyArray<PolicyType> = [
  'schema-fit-biased',
  'error-prioritized',
  'recency-first',
  'hybrid',
];

function sanitizeGoalName(s: string): string {
  // Strip C0 control chars + DEL to prevent terminal escape injection.
  return s.replace(/[\x00-\x1f\x7f]/g, '?');
}

function resolveGoalSession(flags: Record<string, string | boolean | string[]>): { sessionId: string; tenantId: string } {
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : process.env.HIPPO_SESSION_ID ?? ''
  ).trim();
  if (!sessionId) {
    console.error('session id required (set HIPPO_SESSION_ID or pass --session-id)');
    process.exit(1);
  }
  const tenantId = (
    flags['tenant-id'] !== undefined
      ? String(flags['tenant-id'])
      : resolveTenantId({})
  ).trim() || 'default';
  return { sessionId, tenantId };
}

function cmdGoalPush(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const rawName = args.join(' ').trim();
  if (!rawName) {
    console.error('Usage: hippo goal push <name> [--policy <type>] [--success "<condition>"] [--level N] [--parent <goalId>]');
    process.exit(1);
  }
  // Sanitize at WRITE time so corrupt names never enter the DB.
  const name = sanitizeGoalName(rawName);
  if (name !== rawName) {
    console.error('note: stripped control characters from goal name');
  }
  const { sessionId, tenantId } = resolveGoalSession(flags);

  let policy: { policyType: PolicyType } | undefined;
  const policyRaw = flags['policy'];
  if (policyRaw === true) {
    console.error('--policy requires a value (e.g., --policy error-prioritized)');
    process.exit(1);
  }
  if (typeof policyRaw === 'string') {
    if (!(GOAL_POLICY_TYPES as readonly string[]).includes(policyRaw)) {
      console.error(`Unknown --policy '${policyRaw}'. Expected one of: ${GOAL_POLICY_TYPES.join(' | ')}.`);
      process.exit(1);
    }
    policy = { policyType: policyRaw as PolicyType };
  }

  const successRaw = flags['success'];
  if (successRaw === true) {
    console.error('--success requires a value (e.g., --success "<condition>")');
    process.exit(1);
  }
  const successCondition = typeof successRaw === 'string' ? successRaw : undefined;

  const levelRaw = flags['level'];
  let level: number | undefined;
  if (levelRaw === true) {
    console.error('--level requires a value (e.g., --level 1)');
    process.exit(1);
  }
  if (levelRaw !== undefined) {
    const parsed = Number(levelRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2 || !Number.isInteger(parsed)) {
      console.error('--level must be an integer in [0, 2]');
      process.exit(1);
    }
    level = parsed;
  }

  const parentRaw = flags['parent'];
  if (parentRaw === true) {
    console.error('--parent requires a value (e.g., --parent <goalId>)');
    process.exit(1);
  }
  const parentGoalId = typeof parentRaw === 'string' ? parentRaw : undefined;

  const goal = pushGoal(hippoRoot, {
    sessionId,
    tenantId,
    goalName: name,
    level,
    parentGoalId,
    successCondition,
    policy,
  });
  console.log(goal.id);
}

function listAllGoals(hippoRoot: string, sessionId: string, tenantId: string): Goal[] {
  const db = openHippoDb(hippoRoot);
  try {
    const rows = db.prepare(`
      SELECT id, session_id, tenant_id, goal_name, level, parent_goal_id, status,
             success_condition, retrieval_policy_id, created_at, completed_at, outcome_score
      FROM goal_stack
      WHERE tenant_id = ? AND session_id = ?
      ORDER BY created_at ASC
    `).all(tenantId, sessionId) as GoalRow[];
    return rows.map(rowToGoal);
  } finally {
    closeHippoDb(db);
  }
}

function cmdGoalList(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const { sessionId, tenantId } = resolveGoalSession(flags);
  const showAll = Boolean(flags['all']);
  const goals = showAll
    ? listAllGoals(hippoRoot, sessionId, tenantId)
    : getActiveGoals(hippoRoot, { sessionId, tenantId });

  if (goals.length === 0) {
    console.log('(no goals)');
    return;
  }

  // 4-column table: id, status, goal_name, outcome. Plan calls it a "2-column"
  // table but the assertion list (id, status, goal_name, outcome) needs four;
  // tests check for substrings ('active', '0.9', name) so column count is
  // observably four but not asserted.
  const rows = goals.map(g => ({
    id: g.id,
    status: g.status,
    name: sanitizeGoalName(g.goalName),
    outcome: g.outcomeScore !== undefined ? g.outcomeScore.toString() : '-',
  }));
  const widths = {
    id: Math.max(2, ...rows.map(r => r.id.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
    name: Math.max(4, ...rows.map(r => r.name.length)),
    outcome: Math.max(7, ...rows.map(r => r.outcome.length)),
  };
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(`${pad('id', widths.id)}  ${pad('status', widths.status)}  ${pad('name', widths.name)}  ${pad('outcome', widths.outcome)}`);
  for (const r of rows) {
    console.log(`${pad(r.id, widths.id)}  ${pad(r.status, widths.status)}  ${pad(r.name, widths.name)}  ${pad(r.outcome, widths.outcome)}`);
  }
}

function cmdGoalComplete(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const id = args[0];
  if (!id) {
    console.error('Usage: hippo goal complete <id> [--outcome <0..1>] [--no-propagate]');
    process.exit(1);
  }
  let outcomeScore: number | undefined;
  const outcomeRaw = flags['outcome'];
  if (outcomeRaw === true) {
    console.error('--outcome requires a value (e.g., --outcome 0.9)');
    process.exit(1);
  }
  if (outcomeRaw !== undefined) {
    const parsed = Number(outcomeRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      console.error('--outcome must be a number in [0, 1]');
      process.exit(1);
    }
    outcomeScore = parsed;
  }
  const noPropagate = flags['no-propagate'] === true;
  completeGoal(hippoRoot, id, { outcomeScore, noPropagate });
  console.log('ok');
}

function cmdGoalSuspend(hippoRoot: string, args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error('Usage: hippo goal suspend <id>');
    process.exit(1);
  }
  suspendGoal(hippoRoot, id);
  console.log('ok');
}

function cmdGoalResume(hippoRoot: string, args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error('Usage: hippo goal resume <id>');
    process.exit(1);
  }
  resumeGoal(hippoRoot, id);
  console.log('ok');
}

function cmdGoal(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (!sub) {
    console.error('Usage: hippo goal <push|list|complete|suspend|resume> [args]');
    process.exit(1);
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'push':
      cmdGoalPush(hippoRoot, subArgs, flags);
      return;
    case 'list':
      cmdGoalList(hippoRoot, flags);
      return;
    case 'complete':
      cmdGoalComplete(hippoRoot, subArgs, flags);
      return;
    case 'suspend':
      cmdGoalSuspend(hippoRoot, subArgs);
      return;
    case 'resume':
      cmdGoalResume(hippoRoot, subArgs);
      return;
    default:
      console.error(`Unknown goal subcommand: ${sub}. Expected: push | list | complete | suspend | resume.`);
      process.exit(1);
  }
}

function cmdAuth(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (!sub) {
    console.error('Usage: hippo auth <create|list|revoke> [options]');
    process.exit(1);
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'create':
      cmdAuthCreate(hippoRoot, flags);
      return;
    case 'list':
      cmdAuthList(hippoRoot, flags);
      return;
    case 'revoke': {
      const keyId = subArgs[0];
      if (!keyId) {
        console.error('Usage: hippo auth revoke <key_id>');
        process.exit(1);
      }
      cmdAuthRevoke(hippoRoot, keyId, flags);
      return;
    }
    default:
      console.error(`Unknown auth subcommand: ${sub}. Expected: create | list | revoke.`);
      process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Slack subcommands (E1.3 — `hippo slack backfill` / `hippo slack dlq list`)
// ---------------------------------------------------------------------------

function printSlackBackfillUsage(): void {
  console.log('hippo slack backfill --channel <id> [--since ISO]');
  console.log('  --channel  Slack channel id (required, e.g. C0123ABC)');
  console.log('  --since    backfill from ISO timestamp (default: cursor)');
}

function cmdSlackBackfill(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  // M3: detect --help BEFORE token check so operators can read usage in
  // environments without SLACK_BOT_TOKEN configured.
  if (flags['help']) {
    printSlackBackfillUsage();
    return;
  }
  const channel = typeof flags['channel'] === 'string' ? (flags['channel'] as string) : undefined;
  if (!channel) {
    printSlackBackfillUsage();
    process.exit(1);
  }
  // Real fetcher requires SLACK_BOT_TOKEN with channels:history scope.
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN is not set. Backfill requires a Slack bot token with channels:history scope.');
    process.exit(2);
  }
  // --since is advisory in V1: the slack_cursors row drives resume, so the
  // backfill loop always picks up where it last left off. Honoured-by-cursor
  // semantics keep idempotency clean.
  const sinceIso = flags['since'] as string | undefined;
  void sinceIso;
  const fetcher = slackHistoryFetcher(token);
  const ctx = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli:slack-backfill'),
  };
  backfillChannel(ctx, {
    teamId: process.env.SLACK_TEAM_ID ?? 'T_UNKNOWN',
    channel: { id: channel, is_private: false },
    fetcher,
  })
    .then((r) => {
      console.log(`backfill ${channel}: ${r.ingested} new messages across ${r.pages} pages`);
    })
    .catch((e: Error) => {
      console.error('backfill failed:', e.message);
      process.exit(3);
    });
}

function cmdSlackDlqList(hippoRoot: string, _flags: Record<string, string | boolean | string[]>): void {
  const db = openHippoDb(hippoRoot);
  try {
    const tenantId = resolveTenantId({});
    const items = listDlq(db, { tenantId });
    for (const it of items) {
      console.log(`${it.id}\t${it.receivedAt}\t${it.error}`);
    }
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlackDlqReplay(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  const idArg = args[2];
  if (!idArg) {
    console.error('Usage: hippo slack dlq replay <id> [--force]');
    process.exit(1);
  }
  const id = Number(idArg);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
    console.error(`replay: invalid id ${idArg}`);
    process.exit(1);
  }
  const force = flags.force === true;
  const result = replayDlqEntry(
    { hippoRoot },
    id,
    {
      force,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
    },
  );
  if (!result.ok) {
    console.error(
      `replay failed: status=${result.status} retry_count=${result.retryCount}${result.reason ? ` reason=${result.reason}` : ''}`,
    );
    process.exit(1);
  }
  console.log(
    `replay ok: status=${result.status} memory_id=${result.memoryId ?? '(none)'} retry_count=${result.retryCount}`,
  );
}

function printSlackWorkspacesUsage(): void {
  console.log('hippo slack workspaces <add|list|remove> [options]');
  console.log('  add --team <T> --tenant <t>   Register a workspace (upserts on existing team-id)');
  console.log('  list                          List all registered workspaces');
  console.log('  remove --team <T>             Remove a workspace registration');
}

function cmdSlackWorkspacesAdd(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  if (flags['help']) {
    printSlackWorkspacesUsage();
    return;
  }
  const teamId = typeof flags['team'] === 'string' ? (flags['team'] as string).trim() : '';
  const tenantId = typeof flags['tenant'] === 'string' ? (flags['tenant'] as string).trim() : '';
  if (!teamId || !tenantId) {
    console.error('Usage: hippo slack workspaces add --team <T> --tenant <t>');
    process.exit(1);
  }
  const db = openHippoDb(hippoRoot);
  try {
    const ws = addSlackWorkspace(db, { teamId, tenantId });
    console.log(`added: ${ws.teamId} -> ${ws.tenantId} (${ws.addedAt})`);
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlackWorkspacesList(hippoRoot: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    const items = listSlackWorkspaces(db);
    if (items.length === 0) {
      console.log('(no registered workspaces; routing via HIPPO_TENANT fallback)');
      return;
    }
    for (const ws of items) {
      console.log(`${ws.teamId}\t${ws.tenantId}\t${ws.addedAt}`);
    }
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlackWorkspacesRemove(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  if (flags['help']) {
    printSlackWorkspacesUsage();
    return;
  }
  const teamId = typeof flags['team'] === 'string' ? (flags['team'] as string).trim() : '';
  if (!teamId) {
    console.error('Usage: hippo slack workspaces remove --team <T>');
    process.exit(1);
  }
  const db = openHippoDb(hippoRoot);
  try {
    const removed = removeSlackWorkspace(db, teamId);
    if (!removed) {
      console.error(`no workspace registered for team ${teamId}`);
      process.exit(1);
    }
    console.log(`removed: ${teamId}`);
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlack(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (sub === 'backfill') {
    cmdSlackBackfill(hippoRoot, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    cmdSlackDlqList(hippoRoot, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    cmdSlackDlqReplay(hippoRoot, args, flags);
    return;
  }
  if (sub === 'workspaces') {
    const action = args[1];
    if (action === 'add') {
      cmdSlackWorkspacesAdd(hippoRoot, flags);
      return;
    }
    if (action === 'list') {
      cmdSlackWorkspacesList(hippoRoot);
      return;
    }
    if (action === 'remove') {
      cmdSlackWorkspacesRemove(hippoRoot, flags);
      return;
    }
    printSlackWorkspacesUsage();
    process.exit(1);
  }
  console.error(
    'Usage: hippo slack <backfill|dlq list|dlq replay <id> [--force]|workspaces add|workspaces list|workspaces remove> [...]',
  );
  process.exit(1);
}

function printUsage(): void {
  console.log(`
Hippo - biologically-inspired memory system for AI agents

Usage: hippo <command> [options]

Commands:
  init                     Create .hippo/ structure in current directory
    --scan [dir]           Find all git repos under dir (default: ~) and init each
    --days <n>             Days of git history to seed (default: 365 for --scan, 30 for single)
    --global               Init the global store ($HIPPO_HOME or ~/.hippo/)
    --no-hooks             Skip auto-detecting and installing agent hooks
    --no-schedule          Skip auto-creating the machine-level daily runner
    --no-learn             Skip seeding memories from git history
  remember <text>          Store a memory
    --tag <tag>            Add a tag (repeatable)
    --error                Tag as error (boosts retention)
    --pin                  Pin memory (never decays)
    --verified             Set confidence: verified (default)
    --observed             Set confidence: observed
    --inferred             Set confidence: inferred
    --global               Store in global store ($HIPPO_HOME or ~/.hippo/)
  recall <query>           Search and retrieve memories (local + global)
    --budget <n>           Token budget (default: 4000)
    --min-results <n>      Minimum results regardless of budget (default: 1)
    --json                 Output as JSON
    --why                  Show match reasons and source annotations
    --hops <n>             E3.2 multi-hop graph recall: also surface memories
                           reached by walking the entities/relations graph <n>
                           hops (0..3, default off) out from the lexical seeds.
                           Graph hits are tagged [graph: Nhop <rel>]. Today the
                           graph holds supersedes edges (E3.1); cross-object edges
                           light up the same traversal once extracted.
    --max-neighbors <n>    Per-hop fanout cap for --hops (1..200, default 25).
    --graph-stream         L1: fuse a graph-retrieval stream into RRF, re-ranking
                           in-pool results by graph proximity to the strong lexical
                           seeds. Implies rrf scoring (default is blend). Local store
                           only. Distinct from --hops (which injects out-of-pool
                           neighbours); this re-ranks within the candidate pool.
    --graph-hops <n>       Hops for --graph-stream (1..3, default 2).
    --graph-seeds <n>      Lexical anchors for --graph-stream (default 10). The stream
                           re-ranks the rank>seeds tail; on a pool with <= n candidates
                           every candidate is a seed and the stream is inert.
    --no-mmr               Disable MMR diversity re-ranking
    --mmr-lambda <f>       MMR balance 0..1 (default: 0.7, 1.0 = pure relevance)
    --evc-adaptive         ACC-style: when top-K shows high inter-item overlap
                           (= conflict cluster), expand pool and re-rank by
                           recency. Default off. RESEARCH.md §PFC.ACC.
    --filter-conflicts     vlPFC interference filter: drop superseded entries
                           and 0.3x-downweight entries flagged in an open
                           conflict with a peer in the same result set.
                           Uses recorded supersession + conflicts only — never
                           lexical inference. Default off. RESEARCH.md §PFC.vlPFC.
    --value-aware          vmPFC value attribution: boost memories with positive
                           cumulative outcomes and demote those with negative
                           outcomes during ranking. Multiplier
                           clip(1 + 0.3*tanh(pos - neg), 0.7, 1.3). Reuses
                           outcome_positive / outcome_negative; no schema
                           change. Default off. RESEARCH.md §PFC.vmPFC.
    --rerank-utility       OFC option-value re-ranker: combine relevance,
                           strength, and integration cost into a single utility
                           = score * (0.5 + 0.5 * strength) * (1 - cost_factor)
                           where cost_factor = min(0.3, tokens / 10000). Re-sorts
                           results by utility. Default off. RESEARCH.md §PFC.OFC.
    --reranker <name>      Apply a reranker pass after retrieval
                           (cross-encoder|llm). Looks up the named
                           reranker from src/rerankers/index.ts and re-orders
                           the top-K candidates. Default unset (no reranker).
                           See docs/plans/2026-05-10-f6-reranker-hardening.md.
    --reranker-top-k <n>   Cap candidates passed to the reranker (default 50).
    --goal <tag>           dlPFC goal-conditioned recall: memories tagged with
                           the goal tag get a 1.5x score boost and results are
                           re-sorted. Default off. RESEARCH.md §PFC.dlPFC.
    --session-id <id>      Session identifier for dlPFC goal-stack boost.
                           Defaults to \$HIPPO_SESSION_ID. When set and the
                           (tenant, session) has active goals (see
                           'hippo goal push'), recall auto-boosts memories
                           whose tags match an active goal name. Boost stacks
                           on top of base BM25 score, capped at 3.0x.
    --salience-threshold <n>
                           Pineal salience: down-weight memories whose
                           retrieval_count is below n. score *= max(0.5,
                           retrieval_count / n) for entries with count < n;
                           entries at or above n are unchanged. Salience emerges
                           from USE, not from lexical overlap. Default off.
                           RESEARCH.md §"AI Pineal Gland". (v1's creation-time
                           lexical gate destroyed LoCoMo 0.28 -> 0.02; this v2
                           is retrieval-side, opt-in only — see MEMORY.md
                           "Hippo salience gate destroys benchmark recall".)
    --continuity           Include continuity block (active task snapshot,
                           latest matching session handoff, last 5 session
                           events) above the memory list. Useful at agent
                           boot when you want both relevant memories AND
                           where you left off in one call. Anchored on the
                           active snapshot's session_id; no anchor = no
                           handoff/events (use 'hippo session resume' for
                           the explicit handoff-without-snapshot path).
  explain <query>          Show full score breakdown for each retrieved memory
    --budget <n>           Token budget (default: 4000)
    --limit <n>            Cap the number of results displayed
    --json                 Output as JSON
    --physics | --classic  Force search mode (default: from config)
    --no-mmr               Disable MMR diversity re-ranking
    --mmr-lambda <f>       MMR balance 0..1 (default: 0.7, 1.0 = pure relevance)
  trace <id>               Memory dossier: content, decay trajectory, retrievals,
                           outcomes, consolidation parents, open conflicts
    --json                 Output as JSON
  refine                   Rewrite consolidated semantic memories with Claude
    --limit <n>            Cap the number of memories processed this run
    --all                  Ignore \`llm-refined\` tag and re-refine everything
    --dry-run              Call the API but don't write results back
    --model <id>           Override the default model (claude-sonnet-4-6)
    --json                 Output summary as JSON
    (requires ANTHROPIC_API_KEY in env)
  eval [<corpus.json>]     Measure recall quality against a test corpus
    --bootstrap            Generate a synthetic corpus from current memories
    --out <path>           With --bootstrap, write to file instead of stdout
    --max-cases <n>        With --bootstrap, cap case count (default: 50)
    --show-cases           Print per-case details (query, R@10, missed, top 3)
    --compare <path>       JSON from a prior \`eval --json\` run; print deltas
    --no-mmr               Disable MMR for this eval run
    --mmr-lambda <f>       Override MMR lambda for this run
    --embedding-weight <f> Override cosine weight (default: 0.6)
    --local-bump <f>       Local-over-global priority multiplier (default: 1.2)
    --equal-sources        Shortcut for --local-bump 1.0
    --min-mrr <f>          Exit non-zero if mean MRR falls below this
    --json                 Output full summary as JSON
  context                  Smart context injection for AI agents
    --auto                 Auto-detect task from git state
    --budget <n>           Token budget (default: 1500)
    --pinned-only          Only inject pinned memories (used by UserPromptSubmit hook)
    --include-recent <n>   With --pinned-only, also inject the last N writes regardless of pinning
    --format <fmt>         Output format: markdown (default), json, or additional-context (Claude Code hook JSON)
    --framing <mode>       Framing: observe (default), suggest, assert
  sleep                    Run consolidation pass (auto-learns + dedup + auto-shares)
    --dry-run              Preview without writing
    --no-learn             Skip auto git-learn before consolidation
    --no-share             Skip auto-sharing to global store
  daily-runner             Sweep registered workspaces and run daily learn+sleep
  dedup                    Remove duplicate memories (keeps stronger copy)
    --dry-run              Preview without removing
    --threshold <n>        Overlap threshold 0-1 (default: 0.7)
  status                   Show memory health stats
  audit [--fix]            Check memory quality (--fix removes junk)
  github                   GitHub connector subcommands (backfill, dlq)
    backfill --repo <owner/name> [--since ISO] [--max <N>]
                           Paginated backfill of issues + comments
    dlq list               List DLQ entries for the active tenant
    dlq replay <id> [--force]
                           Re-ingest a DLQ entry (--force skips sig check)
  provenance               Provenance coverage gate for kind='raw' rows
    --json                 Output as JSON
    --strict               Exit non-zero when coverage < 100%
  drill <summary-id>       Walk down a DAG level-2 summary to its children
    --limit N              Cap children list (default 50)
    --budget N             Cap total child token cost (≈ chars/4)
    --json                 Output as JSON
  assemble --session <id>  Build a session's chronological context window
    --budget N             Token budget (default 4000)
    --fresh-tail N         Recent rows always kept verbatim (default 10)
    --no-summarize-older   Disable older-row summary substitution
    --scope <s>            Restrict to exact scope (default: deny *:private:*)
    --json                 Output as JSON
  correction-latency       Wall-clock lag from receipt to supersession (p50/p95/max)
    --json                 Output as JSON
  outcome                  Apply feedback to last recall
    --good                 Memories were helpful
    --bad                  Memories were irrelevant
    --id <id>              Target a specific memory
  conflicts                List detected open memory conflicts
    --status <status>      Filter by status (default: open)
    --json                 Output as JSON
  resolve <conflict_id>    Resolve a memory conflict
    --keep <memory_id>     Memory to keep (required)
    --forget               Delete the losing memory (default: halve half-life)
  snapshot <sub>           Persist or inspect the current active task
    snapshot save          Save active task state
      --task <task>
      --summary <summary>
      --next-step <step>
      --source <source>    Optional source label
      --session <id>       Link snapshot to a session trail
    snapshot show          Show the active task snapshot
      --json               Output as JSON
    snapshot clear         Clear the active task snapshot
      --status <status>    Mark final status (default: cleared)
  session <sub>            Append or inspect short-term session history
    session log            Append a structured session event
      --id <session-id>
      --content <text>
      --type <type>        Event type (default: note)
      --task <task>        Optional task label
      --source <source>    Optional source label
    session show           Show recent events for a session or task
      --id <session-id>
      --task <task>
      --limit <n>          Event limit (default: 8)
      --json               Output as JSON
    session latest         Show latest task snapshot + events
      --id <session-id>   Filter by session
      --json               Output as JSON
    session resume         Re-inject latest handoff as context output
      --id <session-id>   Filter by session
  handoff <sub>            Manage session handoffs for continuity
    handoff create         Create a new session handoff
      --summary <text>     Handoff summary (required)
      --next <text>        Next action for successor
      --session <id>       Session ID (auto-generated if omitted)
      --task <id>          Associated task ID
      --artifact <path>    Related file path (repeatable)
    handoff latest         Show the most recent handoff
      --session <id>       Filter by session
      --json               Output as JSON
    handoff show <id>      Show a specific handoff by ID
  current <sub>            Show compact current state for agent injection
    current show           Active task + recent session events (default)
      --json               Output as JSON
  forget <id>              Force remove a memory
    --archive              Archive a raw (append-only) memory instead of deleting
    --reason "<why>"       Reason recorded on the archive (required with --archive)
  inspect <id>             Show full memory detail
  embed                    Embed all memories for semantic search
    --status               Show embedding coverage
  watch "<command>"        Run command, auto-learn from failures
  learn                    Learn lessons from repository history
    --git                  Scan recent git commits for lessons
    --days <n>             Scan this many days back (default: 7)
    --repos <paths>        Comma-separated repo paths to scan
  promote <id>             Copy a local memory to the global store
  share <id>               Share a memory with attribution + transfer scoring
    --force                Share even if transfer score is low
    --auto                 Auto-share all high-transfer-score memories
    --dry-run              Preview what would be shared
    --min-score <n>        Minimum transfer score (default: 0.6)
  peers                    List projects contributing to global store
  sync                     Pull global memories into local project
  import                   Import memories from other AI tools
    --chatgpt <path>       Import from ChatGPT memory export (JSON or txt)
    --claude <path>        Import from CLAUDE.md or Claude memory.json
    --cursor <path>        Import from .cursorrules or .cursor/rules
    --file <path>          Import from any markdown or text file
    --markdown <path>      Import from structured MEMORY.md / AGENTS.md
    --vault <path>         Import a markdown-vault FOLDER as kind='raw' notes
                             (Obsidian/Foam/Dendron). Requires --name <vault>.
                             [--scope <scope>]
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
    --tag <tag>            Add extra tag (repeatable)
  export [file]            Export all memories (default: stdout)
    --format <fmt>         Output format: json (default) or markdown
  capture                  Extract memories from conversation text
    --stdin                Read from piped input
    --file <path>          Read from a file
    --last-session         Read from the most recent agent session transcript
    --transcript <path>    Explicit transcript path (implies --last-session)
    --log-file <path>      Tee output to a log file (paired with 'hippo last-sleep')
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
  setup                    One-shot: detect installed AI tools and install all
                           available SessionEnd+SessionStart hooks
    --all                  Install for every JSON-hook tool, even if not detected
    --dry-run              Show what would be installed without writing
    --no-schedule          Skip installing or repairing the daily runner
  last-sleep               Print the last 'hippo sleep --log-file' output and clear it
    --path <p>             Log path (default: ~/.hippo/logs/last-sleep.log)
    --keep                 Print without clearing
  codex-run [-- ...args]   Launch real Codex behind Hippo's session-end wrapper
  hook <sub> [target]      Manage framework integrations
    hook list              Show available hooks
    hook install <target>  Install hook (claude-code|codex|cursor|openclaw|opencode|pi)
                           claude-code/opencode install SessionEnd+SessionStart;
                           codex wraps the detected launcher in place
    hook uninstall <target> Remove hook
  decide "<decision>"      Record a decision (first-class object + memory mirror)
    --context "<why>"      Why this decision was made
    --supersedes <mem-id>  Supersede the decision backed by this memory id
  decide list [--status active|superseded|closed|all] [--limit N]
                           List decisions (table is authoritative, survives decay)
  decide get <id>          Show a decision by its table id
  decide close <id>        Retire (close) an active decision by its table id
  incident "<incident>"    Record an incident (first-class object + memory mirror)
    --context "<details>"  What happened / surrounding detail
    --link <mem-id>        Link a memory as evidence (repeatable)
  incident list [--status open|resolved|closed|all] [--limit N]
                           List incidents (table is authoritative, survives decay)
  incident get <id>        Show an incident by its table id
  incident resolve <id>    Resolve an open incident (open -> resolved)
    --resolution "<text>"  How it was resolved (required)
  incident close <id>      Retire (close) an open or resolved incident by its table id
  process new "<name>"     Record a process map (first-class object + memory mirror)
    --step "<text>"        An ordered step (repeatable)
    --description "<text>" Optional summary of the process
  process list [--status active|superseded|closed|all] [--limit N]
                           List processes (table is authoritative, survives decay)
  process get <id>         Show a process (with its steps) by its table id
  process supersede <id>   Record a new version that supersedes an active process
    --step "<text>"        A step of the new version (repeatable, required)
    --change "<summary>"   What changed in this version (the delta note)
    --description "<text>" Optional summary of the new version
  process close <id>       Retire (close) an active process by its table id
  policy new "<name>"      Record a policy (bi-temporal first-class object + mirror)
    --text "<rule>"        The policy rule/statement (required)
    --from "<iso>"         Effective-from date (default: now)
    --to "<iso>"           Effective-to date (optional; open-ended if omitted)
  policy list [--status active|superseded|closed|all] [--limit N]
                           List policies (table is authoritative, survives decay)
  policy get <id>          Show a policy by its table id
  policy asof "<iso-date>" Show active policies in force at a valid-time
    --name "<policy>"      Filter to one policy by name
  policy supersede <id>    Record a new version that supersedes an active policy
    --text "<rule>"        The new rule (required)
    --from "<iso>"         New effective-from (default: now)
    --to "<iso>"           New effective-to (optional)
    --change "<summary>"   What changed in this version (the delta note)
  policy close <id>        Retire (close) an active policy by its table id
  skill new "<name>"       Record a skill (reusable agent-followable capability)
    --instructions "<txt>" The skill body (required)
    --trigger "<when>"     Optional: when to apply this skill
  skill list [--status active|superseded|closed|all] [--limit N]
                           List skills (table is authoritative, survives decay)
  skill get <id>           Show a skill by its table id
  skill export             Render active skills as an AGENTS.md/CLAUDE.md markdown block
  skill supersede <id>     Record a new version that supersedes an active skill
    --instructions "<txt>" The new skill body (required)
    --trigger "<when>"     Optional new trigger
    --change "<summary>"   What changed in this version (the delta note)
  skill close <id>         Retire (close) an active skill by its table id
  brief new "<repo>"       Record a repo-scoped project brief
    --summary "<text>"     The brief body (required)
  brief list [--status active|superseded|closed|all] [--repo "<repo>"] [--limit N]
                           List project briefs (table is authoritative, survives decay)
  brief get <id>           Show a project brief by its table id
  brief supersede <id>     Record a new version that supersedes an active brief
    --summary "<text>"     The new brief body (required)
    --change "<summary>"   What changed in this version (the delta note)
  brief close <id>         Retire (close) an active project brief by its table id
  brief refresh "<repo>"   Auto-assemble the brief from the repo's receipts (path:<repo>)
    --dry-run              Print the assembled brief without writing it
  note new "<customer>"    Record a customer/account-scoped note
    --text "<note>"        The note body (required)
  note list [--status active|superseded|closed|all] [--customer "<id>"] [--limit N]
                           List customer notes (table is authoritative, survives decay)
  note get <id>            Show a customer note by its table id
  note supersede <id>      Record a new version that supersedes an active note
    --text "<note>"        The new note body (required)
    --change "<summary>"   What changed in this version (the delta note)
  note close <id>          Retire (close) an active customer note by its table id
  graph extract            Rebuild the entity/relation graph from consolidated objects
                           (decisions/policies/customer-notes/project-briefs); idempotent
  invalidate "<pattern>"   Actively weaken memories matching an old pattern
    --reason "<why>"       Optional: what replaced it
  wm <sub>                 Working memory — bounded buffer for current state
    wm push                Push a working memory entry
      --scope <scope>      Scope name (default: default)
      --content <text>     Content to store (required)
      --importance <n>     Priority 0-1 (default: 0.5)
      --session <id>       Session ID
      --task <id>          Task ID
    wm read                Read working memory entries
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
      --limit <n>          Max entries (default: 20)
      --json               Output as JSON
    wm clear               Clear working memory entries
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
    wm flush               Flush working memory (session end)
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
  dashboard                Open web dashboard for memory health
    --port <n>             Port to serve on (default: 3333)
  mcp                      Start MCP server (stdio transport)
  goal <sub>               dlPFC goal stack (B3) — scoped per session
    goal push <name>       Push a new active goal; prints the new goal id
      --policy <type>      schema-fit-biased | error-prioritized |
                           recency-first | hybrid
      --success "<cond>"   Optional success condition text
      --level <n>          Goal level (default: 0)
      --parent <goalId>    Parent goal id (for sub-goals)
      --session-id <s>     Override session (defaults to HIPPO_SESSION_ID)
      --tenant-id <t>      Override tenant (defaults to HIPPO_TENANT)
    goal list              Show active goals as a table
      --all                Include suspended/completed goals
    goal complete <id>     Mark a goal completed
      --outcome <0..1>     Outcome score; >=0.7 boosts, <0.3 decays recalled mems
      --no-propagate       Close the goal without applying strength side-effects
    goal suspend <id>      Move an active goal to suspended
    goal resume <id>       Move a suspended goal back to active (depth-capped)
  auth <sub>               Manage API keys (A5 stub auth)
    auth create            Mint a new API key (plaintext shown ONCE)
      --label <s>          Optional human label
      --role <r>           admin | member (default: admin; member blocked from /v1/sleep)
      --tenant <id>        Override tenant (defaults to HIPPO_TENANT)
      --json               Output as JSON
      --global             Operate on the global store
    auth list              List API keys (active by default)
      --all                Include revoked keys
      --json               Output as JSON
      --global             Operate on the global store
    auth revoke <key_id>   Revoke an API key (subsequent validate fails)
      --json               Output as JSON
      --global             Operate on the global store
  audit <sub>              Query the append-only audit log (A5 stub auth)
    audit list             List audit events for the active tenant
      --op <op>            Filter by op (remember | recall | promote |
                           supersede | forget | archive_raw | auth_revoke)
      --since <iso>        Lower bound on ts (ISO timestamp)
      --limit <n>          Max events (default: 100, max: 10000)
      --json               Output as JSON
      --global             Operate on the global store

Examples:
  hippo init
  hippo remember "FRED cache can silently drop series" --tag error
  hippo recall "data pipeline issues" --budget 2000
  hippo context --auto --budget 1500
  hippo conflicts
  hippo session log --id sess_123 --task "Ship feature" --type progress --content "Build is green, next step is docs"
  hippo session latest --json
  hippo session resume
  hippo snapshot save --task "Ship feature" --summary "Tests are green" --next-step "Open the PR" --session sess_123
  hippo handoff create --summary "PR is open, tests green" --next "Merge after review" --session sess_123 --artifact src/foo.ts
  hippo embed --status
  hippo watch "npm run build"
  hippo learn --git --days 30
  hippo promote mem_abc123
  hippo sync
  hippo setup
  hippo hook install claude-code
  hippo decide "Use PostgreSQL for new services" --context "JSONB support"
  hippo incident "Prod outage: DB connection pool exhausted" --context "spike at 14:00"
  hippo process new "Release" --step "run tests" --step "bump version" --step "publish"
  hippo policy new "Data retention" --text "Delete logs after 90 days" --from 2026-01-01
  hippo policy asof 2026-03-01 --name "Data retention"
  hippo skill new "Run tests" --instructions "npm test before every commit" --trigger "before commit"
  hippo skill export
  hippo brief new "hippo" --summary "Agent-memory library; E2 first-class objects in progress"
  hippo brief refresh "hippo"
  hippo note new "Acme Corp" --text "Renewal call: wants SSO before Q3; champion is the VP Eng"
  hippo note list --customer "Acme Corp" --status active
  hippo graph extract
  hippo invalidate "REST API" --reason "migrated to GraphQL"
  hippo export memories.json
  hippo export --format markdown memories.md
  hippo sleep --dry-run
  hippo outcome --good
  hippo status
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const { command, args, flags } = parseArgs(process.argv);
const hippoRoot = getHippoRoot(process.cwd());

async function main(): Promise<void> {
  if (command === '--version' || command === '-v' || flags['version']) {
    const __filename_local = fileURLToPath(import.meta.url);
    const __dirname_local = path.dirname(__filename_local);
    const pkgPath = path.join(__dirname_local, '..', 'package.json');
    let pkgJson: string;
    try {
      pkgJson = fs.readFileSync(pkgPath, 'utf-8');
    } catch {
      pkgJson = fs.readFileSync(path.join(__dirname_local, '..', '..', 'package.json'), 'utf-8');
    }
    const { version } = JSON.parse(pkgJson) as { version: string };
    console.log(version);
    process.exit(0);
  }
  maybeAutoInstallCodexWrapper(command, args);
  switch (command) {
    case 'init':
      cmdInit(hippoRoot, flags);
      break;

    case 'remember': {
      let text: string;
      if (args.length === 1 && args[0] === '-') {
        text = fs.readFileSync(0, 'utf-8').trim();
      } else {
        text = args.join(' ').trim();
      }
      if (!text || text.length < 3) {
        console.error('Memory content too short (minimum 3 characters).');
        process.exit(1);
      }
      // Thin-client routing. When a server is up, simple `remember` calls go
      // over HTTP so the daemon stays single-writer (footgun #2). Rich CLI
      // flags (--pin, --layer, --extract, --global, salience gates) still
      // need the direct path; we only intercept the minimal envelope.
      const richFlag =
        flags['pin'] || flags['global'] || flags['extract'] || flags['force'] ||
        flags['observed'] || flags['inferred'] || flags['verified'] ||
        flags['layer'] !== undefined;
      if (!richFlag) {
        const rememberKindRaw = typeof flags['kind'] === 'string' ? (flags['kind'] as string).toLowerCase() : undefined;
        const rememberKindAllowed = ['distilled', 'superseded'] as const;
        if (rememberKindRaw === undefined || (rememberKindAllowed as readonly string[]).includes(rememberKindRaw)) {
          const tagsRaw = flags['tag'];
          const tags = Array.isArray(tagsRaw)
            ? (tagsRaw as string[]).map(String)
            : typeof tagsRaw === 'string' ? [tagsRaw] : undefined;
          // B2 v1.12.6 — validate --owner on the thin-client path too.
          // Failure on this path exits early so the user gets the same
          // validation experience whether or not a server is up.
          const thinOwnerRaw = typeof flags['owner'] === 'string' ? (flags['owner'] as string) : undefined;
          const thinOwnerCheck = validateOwner(thinOwnerRaw, { strict: isStrictOwnerEnv() });
          if (!thinOwnerCheck.ok) {
            console.error(thinOwnerCheck.message);
            process.exit(1);
          }
          if (thinOwnerCheck.message) console.error(thinOwnerCheck.message);
          const remembered = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
            const result = await client.remember(info.url, apiKey, {
              content: text,
              kind: rememberKindRaw as ('distilled' | 'superseded' | undefined),
              scope: typeof flags['scope'] === 'string' ? (flags['scope'] as string) : undefined,
              owner: thinOwnerCheck.value,
              artifactRef: typeof flags['artifact-ref'] === 'string' ? (flags['artifact-ref'] as string) : undefined,
              tags,
            });
            console.log(`Remembered [${result.id}] (via ${info.url})`);
            console.log(`   Kind: ${result.kind} | Tenant: ${result.tenantId}`);
          });
          if (remembered) break;
        }
      }
      await cmdRemember(hippoRoot, text, flags);
      break;
    }

    case 'recall': {
      const query = args.join(' ').trim();
      if (!query) {
        console.error('Please provide a search query.');
        process.exit(1);
      }
      await cmdRecall(hippoRoot, query, flags);
      break;
    }

    case 'drill': {
      const summaryId = args[0];
      if (!summaryId) {
        console.error('Usage: hippo drill <summary-id> [--limit N] [--budget N]');
        process.exit(1);
      }
      cmdDrillDown(hippoRoot, summaryId, flags);
      break;
    }

    case 'assemble': {
      const sessionId = typeof flags['session'] === 'string' ? (flags['session'] as string) : args[0];
      if (!sessionId) {
        console.error('Usage: hippo assemble --session <id> [--budget N] [--fresh-tail N] [--no-summarize-older] [--json]');
        process.exit(1);
      }
      cmdAssemble(hippoRoot, sessionId, flags);
      break;
    }

    case 'supersede': {
      const oldId = args[0];
      const newContent = args.slice(1).join(' ').trim();
      if (!oldId || !newContent) {
        console.error('Usage: hippo supersede <old-id> "<new content>" [--layer L] [--tag T] [--pin]');
        process.exit(1);
      }
      cmdSupersede(hippoRoot, oldId, newContent, flags);
      break;
    }

    case 'explain': {
      const query = args.join(' ').trim();
      if (!query) {
        console.error('Please provide a search query.');
        process.exit(1);
      }
      await cmdExplain(hippoRoot, query, flags);
      break;
    }

    case 'eval': {
      const corpusPath = args[0] ? String(args[0]) : null;
      await cmdEval(hippoRoot, corpusPath, flags);
      break;
    }

    case 'trace': {
      const sub = args[0] ? String(args[0]) : '';
      if (sub === 'record') {
        cmdTraceRecord(hippoRoot, flags);
        break;
      }
      if (!sub) {
        console.error('Usage: hippo trace <memory-id> | hippo trace record --task <t> --steps <json> --outcome <o>');
        process.exit(1);
      }
      cmdTrace(hippoRoot, sub, flags);
      break;
    }

    case 'refine':
      await cmdRefine(hippoRoot, flags);
      break;

    case 'sleep':
      await cmdSleep(hippoRoot, flags);
      break;

    case 'last-sleep':
      cmdLastSleep(flags);
      break;

    case 'session-end':
      cmdSessionEnd(hippoRoot, flags);
      break;

    case '__session-end-worker':
      cmdSessionEndWorker(hippoRoot, flags);
      break;

    case 'codex-run':
      cmdCodexRun(hippoRoot, args);
      break;

    case '__codex-session-end-worker':
      cmdCodexSessionEndWorker(hippoRoot, flags);
      break;

    case 'dedup':
      cmdDedup(hippoRoot, flags);
      break;

    case 'dag':
      cmdDag(hippoRoot, flags);
      break;

    case 'auth':
      cmdAuth(hippoRoot, args, flags);
      break;

    case 'goal':
      cmdGoal(hippoRoot, args, flags);
      break;

    case 'slack':
      cmdSlack(hippoRoot, args, flags);
      break;

    case 'github':
      await cmdGithub(hippoRoot, args, flags);
      break;

    case 'audit': {
      // `audit list` and `audit prune` -> A5 audit-log subcommands.
      // Other forms (no sub, --fix) keep the existing memory-quality auditor
      // for backwards compatibility.
      if (args[0] === 'list' || args[0] === 'prune') {
        cmdAuditLog(hippoRoot, args, flags);
        break;
      }
      requireInit(hippoRoot);
      const entries = loadAllEntries(hippoRoot);
      const result = auditMemories(entries);
      const shouldFix = Boolean(flags['fix']);

      if (result.issues.length === 0) {
        console.log(`All ${result.total} memories passed quality checks.`);
      } else {
        console.log(`Audited ${result.total} memories: ${result.clean} clean, ${result.issues.length} issues\n`);
        for (const issue of result.issues) {
          const icon = issue.severity === 'error' ? 'ERR' : 'WARN';
          console.log(`  [${icon}] ${issue.memoryId}: ${issue.reason}`);
          console.log(`         "${issue.content.slice(0, 80)}${issue.content.length > 80 ? '...' : ''}"`);
        }
        if (shouldFix) {
          const errorIds = result.issues.filter(i => i.severity === 'error').map(i => i.memoryId);
          if (errorIds.length > 0) {
            for (const id of errorIds) {
              deleteEntry(hippoRoot, id);
            }
            console.log(`\nRemoved ${errorIds.length} error-severity memories.`);
            console.log(`${result.issues.length - errorIds.length} warnings remain (review manually).`);
          } else {
            console.log(`\nNo error-severity issues. Warnings require manual review.`);
          }
        } else {
          console.log(`\nRun with --fix to auto-remove error-severity issues.`);
        }
      }
      break;
    }

    case 'correction-latency': {
      requireInit(hippoRoot);
      const entries = loadAllEntries(hippoRoot);
      const report = buildCorrectionLatency(entries);
      if (flags['json']) {
        console.log(JSON.stringify(report, null, 2));
      } else if (report.count === 0) {
        console.log('No supersessions found. Correction latency is undefined.');
      } else {
        const fmt = (ms: number | null) => {
          if (ms === null) return 'n/a';
          if (ms < 1000) return `${ms}ms`;
          if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
          if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
          return `${(ms / 3_600_000).toFixed(1)}h`;
        };
        console.log(`Corrections: ${report.count} total (${report.extractionCount} extraction-driven, ${report.manualCount} manual)`);
        console.log(`Latency p50: ${fmt(report.p50Ms)}, p95: ${fmt(report.p95Ms)}, max: ${fmt(report.maxMs)}`);
        if (report.extractionCount === 0 && report.manualCount > 0) {
          console.log(`\nAll ${report.manualCount} corrections were manual supersedes: no measurable observation lag.`);
          console.log(`To measure latency, route corrections through extraction (set new.extracted_from to the raw receipt).`);
        }
      }
      break;
    }

    case 'provenance': {
      requireInit(hippoRoot);
      const entries = loadAllEntries(hippoRoot);
      const coverage = buildProvenanceCoverage(entries);
      if (flags['json']) {
        console.log(JSON.stringify(coverage, null, 2));
      } else if (coverage.rawTotal === 0) {
        console.log('No kind=raw memories present. Coverage gate trivially satisfied.');
      } else {
        const pct = (coverage.coverage * 100).toFixed(1);
        console.log(`Provenance coverage: ${coverage.rawWithEnvelope}/${coverage.rawTotal} raw rows envelope-complete (${pct}%)`);
        if (coverage.gaps.length > 0) {
          console.log(`\nGaps:`);
          for (const g of coverage.gaps) {
            console.log(`  ${g.id}: missing ${g.missing.join(', ')}`);
          }
        }
      }
      if (flags['strict'] && coverage.coverage < 1) {
        process.exit(1);
      }
      break;
    }

    case 'status':
      cmdStatus(hippoRoot);
      break;

    case 'outcome':
      cmdOutcome(hippoRoot, flags);
      break;

    case 'conflicts':
      cmdConflicts(hippoRoot, flags);
      break;

    case 'resolve':
      cmdResolve(hippoRoot, args, flags);
      break;

    case 'snapshot':
      cmdSnapshot(hippoRoot, args, flags);
      break;

    case 'session':
      cmdSession(hippoRoot, args, flags);
      break;

    case 'handoff':
      cmdHandoff(hippoRoot, args, flags);
      break;

    case 'predict':
      cmdPredict(hippoRoot, args, flags);
      break;

    case 'current':
      cmdCurrent(hippoRoot, args, flags);
      break;

    case 'forget': {
      const id = args[0];
      if (!id) {
        console.error('Please provide a memory ID.');
        process.exit(1);
      }
      // A3: --archive is a direct-DB operation (raw archival via archiveRaw);
      // the HTTP forget route does not carry it, so archive requests always
      // take the direct path rather than silently no-op'ing over a server.
      if (flags['archive'] !== true) {
        const routed = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
          try {
            await client.forget(info.url, apiKey, id);
            console.log(`Forgot ${id}`);
          } catch (err) {
            console.error((err as Error).message);
            process.exit(1);
          }
        });
        if (routed) break;
      }
      cmdForget(hippoRoot, id, flags);
      break;
    }

    case 'inspect': {
      const id = args[0];
      if (!id) {
        console.error('Please provide a memory ID.');
        process.exit(1);
      }
      cmdInspect(hippoRoot, id);
      break;
    }

    case 'context':
      await cmdContext(hippoRoot, args, flags);
      break;

    case 'hook':
      cmdHook(args, flags);
      break;

    case 'setup':
      cmdSetup(flags);
      break;

    case 'daily-runner':
      cmdDailyRunner();
      break;

    case 'embed':
      await cmdEmbed(hippoRoot, flags);
      break;

    case 'watch': {
      const watchCmd = args.join(' ').trim();
      await cmdWatch(watchCmd, hippoRoot);
      break;
    }

    case 'learn':
      cmdLearn(hippoRoot, flags);
      break;

    case 'promote': {
      const id = args[0];
      if (!id) {
        console.error('Please provide a memory ID.');
        process.exit(1);
      }
      const promoted = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
        try {
          const result = await client.promote(info.url, apiKey, id);
          console.log(`Promoted ${id} to global store as ${result.globalId}`);
        } catch (err) {
          console.error(`Failed to promote: ${(err as Error).message}`);
          process.exit(1);
        }
      });
      if (promoted) break;
      cmdPromote(hippoRoot, id);
      break;
    }

    case 'sync':
      cmdSync(hippoRoot);
      break;

    case 'share': {
      const shareId = args[0];
      if (shareId === '--auto' || flags['auto']) {
        // Auto-share mode
        requireInit(hippoRoot);
        const minScore = parseFloat(String(flags['min-score'] ?? '0.6'));
        const dryRun = Boolean(flags['dry-run']);
        const results = autoShare(hippoRoot, { minScore, dryRun, tenantId: resolveTenantId({}) });
        if (results.length === 0) {
          console.log('No memories meet the sharing threshold.');
        } else if (dryRun) {
          console.log(`Would share ${results.length} memories:\n`);
          for (const e of results) {
            const score = transferScore(e);
            console.log(`  ${e.id} (transfer=${fmt(score)}) ${e.content.slice(0, 80)}...`);
          }
        } else {
          console.log(`Shared ${results.length} memories to global store.`);
          for (const e of results) {
            console.log(`  ${e.id} <- ${e.source}`);
          }
        }
      } else if (shareId) {
        requireInit(hippoRoot);
        const force = Boolean(flags['force']);
        const tenantId = resolveTenantId({});
        const result = shareMemory(hippoRoot, shareId, { force, tenantId });
        if (result) {
          console.log(`Shared [${result.id}] to global store.`);
          console.log(`  Source: ${result.source}`);
        } else {
          const entry = readEntry(hippoRoot, shareId, tenantId);
          if (entry) {
            const score = transferScore(entry);
            console.log(`Transfer score too low (${fmt(score)}). This memory looks project-specific.`);
            console.log('Use --force to share anyway.');
          } else {
            console.error(`Memory not found: ${shareId}`);
            process.exit(1);
          }
        }
      } else {
        console.error('Usage: hippo share <memory_id> [--force] or hippo share --auto [--dry-run]');
        process.exit(1);
      }
      break;
    }

    case 'peers': {
      // D4 v1.12.10: tenant-scoped by default. --all-tenants restores the
      // pre-D4 host-wide view for the rare operator who genuinely wants
      // cross-tenant peer discovery.
      const allTenants = flags['all-tenants'] === true;
      const tenantScope = allTenants ? undefined : resolveTenantId({});
      const peers = listPeers(undefined, tenantScope);
      if (peers.length === 0) {
        console.log('No peers found. Share memories with: hippo share <id>');
      } else {
        const scopeLabel = allTenants ? 'global store (all tenants)' : `global store (tenant "${tenantScope}")`;
        console.log(`${peers.length} project${peers.length === 1 ? '' : 's'} contributing to ${scopeLabel}:\n`);
        for (const p of peers) {
          console.log(`  ${p.project.padEnd(25)} ${String(p.count).padStart(4)} memories  (latest: ${p.latest.slice(0, 10)})`);
        }
      }
      break;
    }

    case 'import':
      cmdImport(hippoRoot, args, flags);
      break;

    case 'export': {
      requireInit(hippoRoot);
      const format = (flags['format'] as string) || 'json';
      const outputPath = args[0] || null;
      const entries = loadAllEntries(hippoRoot);

      let output: string;
      if (format === 'markdown' || format === 'md') {
        output = entries.map(e => {
          const meta = [
            `id: ${e.id}`,
            `created: ${e.created}`,
            `tags: ${e.tags.join(', ')}`,
            `confidence: ${e.confidence}`,
            `half_life: ${e.half_life_days}d`,
            `strength: ${e.strength.toFixed(2)}`,
          ].join(' | ');
          return `### ${e.id}\n\n${e.content}\n\n_${meta}_`;
        }).join('\n\n---\n\n');
      } else {
        output = JSON.stringify(entries, null, 2);
      }

      if (outputPath) {
        fs.writeFileSync(outputPath, output, 'utf8');
        console.log(`Exported ${entries.length} memories to ${outputPath}`);
      } else {
        console.log(output);
      }
      break;
    }

    case 'capture': {
      let captureSource: CaptureOptions['source'] | null = null;
      let captureFile: string | undefined;
      let transcriptPath: string | undefined;

      if (flags['stdin']) { captureSource = 'stdin'; }
      else if (flags['file']) { captureSource = 'file'; captureFile = String(flags['file']); }
      else if (flags['last-session']) { captureSource = 'last-session'; }

      if (flags['transcript']) {
        transcriptPath = String(flags['transcript']);
        if (!captureSource) captureSource = 'last-session';
      }

      if (!captureSource) {
        console.error('Usage: hippo capture --stdin|--file <path>|--last-session [--transcript <path>] [--log-file <path>] [--dry-run] [--global]');
        process.exit(1);
      }

      cmdCapture(hippoRoot, {
        source: captureSource,
        filePath: captureFile,
        transcriptPath,
        logFile: typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined,
        dryRun: Boolean(flags['dry-run']),
        global: Boolean(flags['global']),
        tenantId: resolveTenantId({}),
      });
      break;
    }

    case 'dashboard': {
      requireInit(hippoRoot);
      const port = parseInt(String(flags['port'] ?? '3333'), 10);
      const { serveDashboard } = await import('./dashboard.js');
      serveDashboard(hippoRoot, port);
      await new Promise(() => {}); // run until Ctrl+C
      break;
    }

    case 'wm':
      cmdWm(hippoRoot, args, flags);
      break;

    case 'mcp': {
      // Start MCP server over stdio. Dynamic import keeps main CLI lean; the
      // dispatcher itself is transport-agnostic, so we explicitly attach the
      // stdio loop here. (HTTP/SSE transport is wired in src/server.ts and
      // imports the same module without triggering stdin handlers.)
      const mod = await import('./mcp/server.js');
      mod.startStdioLoop();
      // Server runs until stdin closes, so we never reach here
      await new Promise(() => {}); // hang forever
      break;
    }

    case 'serve': {
      requireInit(hippoRoot);
      const portRaw = flags['port'] ?? process.env['HIPPO_PORT'] ?? '6789';
      const port = Number(portRaw);
      if (!Number.isFinite(port) || port < 0) {
        console.error(`Invalid --port: ${String(portRaw)}`);
        process.exit(1);
      }
      const host = typeof flags['host'] === 'string' ? (flags['host'] as string) : '127.0.0.1';
      const { serve } = await import('./server.js');
      const handle = await serve({ hippoRoot, port, host });
      console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
      console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
      console.log('press Ctrl+C to stop');
      // SIGINT/SIGTERM handlers wired in server.ts (skipped under VITEST). Hang.
      await new Promise(() => {});
      break;
    }

    case 'invalidate': {
      requireInit(hippoRoot);
      const target = args[0];
      if (!target) {
        console.error('Usage: hippo invalidate "<old pattern>" [--reason "<why>"]');
        process.exit(1);
      }
      const reason = flags['reason'] as string || null;
      const invTarget: InvalidationTarget = {
        from: target,
        to: reason,
        type: 'migration',
      };
      const result = invalidateMatching(hippoRoot, invTarget, resolveTenantId({}));
      if (result.invalidated === 0) {
        console.log(`No memories matched "${target}".`);
      } else {
        console.log(`Invalidated ${result.invalidated} memories referencing "${target}".`);
        result.targets.forEach(id => console.log(`   ${id}`));
      }
      break;
    }

    case 'decide':
      cmdDecide(hippoRoot, args, flags);
      break;

    case 'incident':
      cmdIncident(hippoRoot, args, flags);
      break;

    case 'process':
      cmdProcess(hippoRoot, args, flags);
      break;

    case 'policy':
      cmdPolicy(hippoRoot, args, flags);
      break;

    case 'skill':
      cmdSkill(hippoRoot, args, flags);
      break;

    case 'brief':
    case 'project-brief':
      cmdProjectBrief(hippoRoot, args, flags);
      break;

    case 'note':
    case 'customer-note':
      cmdCustomerNote(hippoRoot, args, flags);
      break;

    case 'graph':
      cmdGraph(hippoRoot, args, flags);
      break;

    case 'help':
    case '--help':
    case '-h':
    case '':
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message ?? err);
  process.exit(1);
});
