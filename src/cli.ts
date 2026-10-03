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
 *   hippo card <create|show|list|claim|heartbeat|block|review|complete|reclaim|comment>
 *   hippo current <show>
 *   hippo forget <id> [--archive --reason "<why>"]
 *   hippo reject <id>|--value "<text>" --reason "<why>"
 *   hippo rejections
 *   hippo unreject <digest-prefix>
 *   hippo dormant [<query>] [--limit <n>] [--json] | restore <id> | forget <id>
 *   hippo tokens [--days <n>] [--json] [--global]
 *   hippo doctor [--json]
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

import { evalNow } from './ablation.js';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'child_process';
import {
  installJsonHooks,
  uninstallJsonHooks,
  resolveJsonHookPaths,
  detectInstalledTools,
  defaultSleepLogPath,
  ensureCodexWrapperInstalled,
  installCodexWrapper,
  detectRealCodexPath,
  isCodexPresent,
  isCodexWrapperInstalled,
  repairCodexWrapperIfInstalled,
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
  createSuccessor,
  calculateStrength,
  calculateRewardFactor,
  deriveHalfLife,
  resolveConfidence,
  confidenceFacets,
  confidenceLabel,
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
  strengthenRetrieved,
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
  loadFreshActiveTaskSnapshot,
  closeTaskSnapshotsForSession,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
  listMemoryConflicts,
  resolveConflict,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  stampHandoffOutcome,
  writeSessionEndHandoff,
  TaskSnapshot,
  SessionEvent,
  memoriesBackingObjects,
} from './store.js';
import {
  createCard,
  loadCard,
  listCards,
  loadCardRuns,
  claimCard,
  heartbeatCard,
  blockCard,
  reviewCard,
  completeCard,
  reclaimExpiredCards,
  addCardComment,
} from './store-cards.js';
import { rejectValue, unrejectValue, listRejectionsForTenant } from './reject-flow.js';
import { RejectedValueError } from './rejection.js';
import { isHandoffOutcome, formatHandoffEvidenceLine, type SessionHandoff, type HandoffOutcome } from './handoff.js';
import { readSessionScan, recordSessionDigest } from './session-digest.js';
import { type Card, isCardStatus } from './card.js';
import { loadCardDetail, type CardDetail } from './card-detail.js';
import { passesScopeFilterForRecall } from './recall-scope.js';
import { search, estimateTokens, fitBudget, explainMatch, type SearchResult } from './search.js';
import { renderTraceContent, parseSteps } from './trace.js';
import { writeDeliveryEventAtRoot, writeDeliveryEventOnHandle, writeRecallTraceAtRoot } from './recall-trace.js';
import { createDeliveryRecorder, type DeliveryRecorder } from './delivery-recorder.js';
import { consolidate } from './consolidate.js';
import { deduplicateStore } from './dedupe.js';
import {
  embedAll,
  embedMemory,
  loadEmbeddingIndex,
  resolveEmbeddingModel,
  embeddingModelRequiresReindex,
} from './embeddings.js';
import { resolveEmbeddingProvider } from './embedding-provider.js';
import { loadPhysicsState, resetAllPhysicsState } from './physics-state.js';
import { computeSystemEnergy, vecNorm } from './physics.js';
import { loadConfig } from './config.js';
import { ARM_LOCK_WAIT_MS, ensurePilotArm, hashArm, readPilotArm } from './pilot-arm.js';
import { openHippoDb, closeHippoDb, withSharedStoreHandles, HOOK_DB_WAIT_MS, isSqliteBusy, noteStoreBusy } from './db.js';
import { runDoctor, formatDoctor } from './doctor.js';
import { buildSupportBundle, TAIL_MAX_LINES } from './support-bundle.js';
import { PACKAGE_VERSION } from './version.js';
import { captureToolFailure } from './capture-error.js';
import type { JsonValue } from './working-memory.js';
import {
  blockHash, isSubagentPayload, lastSentState, readApiCalls, recordRereads, recordTokenUse, shouldSkipUnchanged,
  type TokenSurface, type TranscriptCalls,
} from './token-ledger.js';
import { FAILURE_LOG_RETENTION_DAYS } from './failure-log.js';
import { getActiveGoalsWithDb, MAX_FINAL_MULTIPLIER, pushGoal, getActiveGoals, completeGoal, suspendGoal, resumeGoal, writeGoalRecallLog } from './goals.js';
import type { RetrievalPolicy, PolicyType, Goal, GoalRow } from './goals.js';
import { rowToGoal } from './goals.js';
import {
  captureError,
  runWatched,
  isGitRepo,
} from './autolearn.js';
import { dropHeldCopies } from './same-text.js';
import {
  currentMachine,
  importAtCompaction,
  importAtSessionEnd,
  importForStore,
  importProjectMemories,
  importUserMemories,
} from './agent-memories/sync.js';
import { detailLines, emptyReport, mergeReports, summaryLine } from './agent-memories/report.js';
import { invalidateMatching, InvalidationTarget } from './invalidation.js';
import { deriveOriginProject, isGlobalStoreRoot } from './project-identity.js';
import { extractPathTags } from './path-context.js';
import { autoDetectContext } from './context-auto.js';
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
  syncGlobalToLocal,
} from './shared.js';
import {
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
import { cmdCapture, CaptureOptions, cmdPreCompact, cmdPostCompact, resolveLastSessionTranscript, truncateCodePointSafe, transcriptWorkingState } from './capture.js';
import { COMPACTION_DB_WAIT_MS, replayCompactionsAt } from './compaction-record.js';
import { readStdinBounded } from './stdin.js';
import {
  auditMemories,
  auditQueryFields,
  queryAuditEvents,
  AUDIT_OPS,
  type AuditEvent,
  type AuditOp,
  type AuditResult,
} from './audit.js';
import { createApiKey, listApiKeys, type ApiKeyListItem } from './auth.js';
import { buildProvenanceCoverage } from './provenance-coverage.js';
import { buildCorrectionLatency } from './correction-latency.js';
import * as api from './api.js';
import { vetSecrets } from './secret-detect.js';
import * as predictionsModule from './predictions.js';
import { computePlanningFallacyOutput, type PlanningFallacyOutput } from './predictions.js';
import * as decisionsModule from './decisions.js';
import * as incidentsModule from './incidents.js';
import * as processesModule from './processes.js';
import * as policiesModule from './policies.js';
import * as skillsModule from './skills.js';
import * as briefsModule from './project-briefs.js';
import * as customerNotesModule from './customer-notes.js';
import { extractGraph } from './graph-extract.js';
import { buildGraphModel, renderGraphHtml, renderGraphCanvas, DEFAULT_VIEW_LIMIT } from './graph-view.js';
import {
  detectAnchoring,
  hashQueryText,
  biasHintEnabled,
  buildSessionKey,
  getOrCreateRing,
  appendRecall,
  snapshotRing,
  RingBuffer,
} from './recall-history.js';
import { detectAvailabilityBias } from './availability.js';

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
import { resolveTenantId } from './tenant.js';
import { runEval, bootstrapCorpus, compareSummaries, type EvalCase, type EvalSummary } from './eval.js';
import { runFeatureEval, formatResult, resultToBaseline, detectRegressions, type EvalBaseline } from './eval-suite.js';
import { refineStore } from './refine-llm.js';
import { wmPush, wmRead, wmClear, wmFlush, WorkingMemoryItem } from './working-memory.js';
import { MAX_HOPS, DEFAULT_MAX_NEIGHBORS } from './graph-recall.js';
import { getReranker } from './rerankers/index.js';
import type { RerankerFn } from './rerankers/types.js';
import { rankRecall, type RankStage, type RecallGraphHops, type RecallGraphStream, type RecallReranker } from './recall-pipeline.js';
import { JEV_DEFAULT_TOP_K } from './rerankers/jev.js';
import { computeSalience } from './salience.js';
import { renderAmbientSummary } from './ambient.js';
import {
  assembleCost, assembleHeading, contextCost, contextHeading, contextLine, crossProjectHeading, crossProjectLine, drillCost, handoffText,
  printedTokens, sessionTrailText, settleTokens, snapshotText,
} from './context-render.js';
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
import { cmdGithub, printGithubBackfillUsage } from './connectors/github/cli-impl.js';
import {
  parseLimitFlag,
  parseCountFlag,
  parseBudgetFlag,
  emitCliAudit,
  requireInit,
  runChurnStaleForRepo,
  runViaServerIfAvailable,
  fmt,
  recallEntryText,
  recallHeading,
  printAgentImport,
  hippoBlock,
  installCodexMemoryHooks,
  setupDailySchedule,
  type CliFlags,
  parseAsOfFlag,
  engineFlags,
  collectHandoffEvidence,
  logSessionEndImport,
  appendSessionEndCloseLog,
  printActiveTaskSnapshot,
  printSessionEvents,
  printHandoff,
  cardStringFlag,
  hostSessionId,
  resetHookInjection,
  captureConsole,
  hookStoreRoot,
  withLedgerDb,
  learnFromRepo,
  HOOK_MARKERS,
  HOOKS,
  resolveAuthRoot,
} from './cli/shared.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every switch the CLI reads. A value on one reads as on under Boolean() (`--fix=false` would fix)
// and as off under === true (`--pin=true` would not pin), so parseArgs and main() refuse one.
// tests/cli-parse-flag-equals.test.ts fails when a switch read is missing from this set.
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'agents', 'all', 'all-tenants', 'archive', 'auto', 'bad', 'bootstrap', 'classic', 'churn', 'continuity',
  'cross-project', 'dry-run', 'equal-sources', 'error', 'evc-adaptive', 'extract',
  'filter-conflicts', 'fix', 'force', 'forget', 'git', 'global', 'good', 'graph-stream',
  'help', 'include-logs', 'include-superseded', 'inferred', 'json', 'last-session', 'multihop', 'no-hooks',
  'no-learn', 'no-mmr', 'no-propagate', 'no-schedule', 'no-share', 'no-summarize-older',
  'observed', 'open', 'physics', 'pin', 'pinned-only', 'reject-loser', 'rerank-utility',
  'reset-physics', 'save-baseline', 'show-cases', 'stats', 'stdin',
  'strict', 'suite', 'value-aware', 'verified', 'version', 'why',
]);

// Every flag some command reads. Anything else is a typo that no command would act on.
export const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...BOOLEAN_FLAGS,
  'actual', 'artifact', 'artifact-ref', 'as-of', 'author', 'baseline', 'body', 'budget', 'card-id',
  'change', 'channel', 'chatgpt', 'class', 'claude', 'codex-home', 'compare', 'constraint', 'content',
  'context', 'contract', 'cursor', 'customer', 'days', 'depends-on', 'depth', 'description',
  'embedding-weight', 'entity', 'estimate', 'file', 'format', 'framing', 'fresh-tail', 'from', 'goal',
  'graph-hops', 'graph-seeds', 'history-path', 'hops', 'host', 'id', 'importance', 'include-recent',
  'instructions', 'keep', 'kind', 'label', 'layer', 'level', 'limit', 'link', 'local-bump', 'log-file',
  'markdown', 'max', 'max-cases', 'max-neighbors', 'min-mrr', 'min-results', 'min-score', 'mmr-lambda',
  'model', 'name', 'next', 'next-step', 'note', 'older-than', 'op', 'out', 'outcome', 'owner', 'parent',
  'path', 'policy', 'port', 'reason', 'repo', 'repos', 'reranker', 'reranker-top-k', 'resolution',
  'role', 'run', 'runtime', 'salience-threshold', 'scan', 'scope', 'session', 'session-id', 'since',
  'source', 'start-offset', 'started-at', 'state', 'status', 'step', 'steps', 'success', 'summary',
  'supersedes', 'tag', 'target', 'target-runtime', 'task', 'team', 'tenant', 'tenant-id', 'tests',
  'text', 'threshold', 'title', 'to', 'transcript', 'trigger', 'type', 'unit', 'value', 'vault',
]);

// Commands that delete or hide memories: an unknown flag here stops the run instead of being ignored.
const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'audit', 'dedup', 'forget', 'invalidate', 'reject', 'resolve', 'sleep', 'supersede',
]);

// Commands that honour --dry-run. Any other command would ignore it and run for real.
const DRY_RUN_COMMANDS: ReadonlySet<string> = new Set([
  'audit', 'capture', 'dedup', 'forget', 'import', 'invalidate', 'refine', 'setup', 'sleep',
]);

// share and brief honour --dry-run in one form only; their other forms write for real.
function dryRunRefusal(command: string, args: string[], flags: Record<string, string | boolean | string[]>): string | null {
  const isBrief = command === 'brief' || command === 'project-brief';
  const onlyForm = command === 'share' ? 'share --auto' : isBrief ? `${command} refresh` : null;
  const honoured = command === 'share' ? args[0] === '--auto' || Boolean(flags['auto'])
    : isBrief ? args[0] === 'refresh' : DRY_RUN_COMMANDS.has(command);
  if (honoured) return null;
  const where = onlyForm ? ` outside \`hippo ${onlyForm}\`` : '';
  return `hippo ${command} has no --dry-run${where}, so it would run for real. Nothing was changed.`;
}

// Shared by both the separated and glued (`=`) forms so the list can't drift.
function isRepeatableFlag(key: string): boolean {
  return key === 'tag' || key === 'artifact' || key === 'link' || key === 'step' || key === 'constraint' || key === 'depends-on';
}

function pushRepeatableFlag(flags: Record<string, string | boolean | string[]>, key: string, value: string): void {
  if (Array.isArray(flags[key])) {
    // SAFETY: Array.isArray just confirmed flags[key] is an array; the union has no other array member.
    (flags[key] as string[]).push(value);
  } else {
    flags[key] = [value];
  }
}

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean | string[]> } {
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
      const eqIdx = part.indexOf('=');
      if (eqIdx > 2) {
        // Glued form has no following token to swallow, so BOOLEAN_FLAGS gets its
        // own branch here instead of the swallow-avoidance short-circuit below.
        const key = part.slice(2, eqIdx);
        const value = part.slice(eqIdx + 1);
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = value;
        } else if (isRepeatableFlag(key)) {
          if (value !== '') pushRepeatableFlag(flags, key, value);
        } else {
          flags[key] = value === '' ? true : value;
        }
        i++;
        continue;
      }

      const key = part.slice(2);
      const next = rest[i + 1];

      if (BOOLEAN_FLAGS.has(key) && (next === 'true' || next === 'false')) {
        // Kept as a value so main() rejects it, instead of `--pin true` pinning the text "... true".
        flags[key] = next;
        i += 2;
      } else if (!next || next.startsWith('--') || BOOLEAN_FLAGS.has(key)) {
        // Boolean flag
        flags[key] = true;
        i++;
      } else if (isRepeatableFlag(key)) {
        pushRepeatableFlag(flags, key, next);
        i += 2;
      } else {
        flags[key] = next;
        i += 2;
      }
    } else if (part === '-h') {
      // Running a verb when help was asked costs more than losing a literal -h; `-- -h` still passes one.
      flags['help'] = true;
      i++;
    } else {
      args.push(part);
      i++;
    }
  }

  return { command, args, flags };
}

// JSON.stringify keeps quotes or parens in the matched phrase from blurring the line.
function planningLine(p: PlanningFallacyOutput): string | null {
  if (p.hint) return `Planning fallacy hint (class: ${p.hint.classTag}): ${p.hint.baserateSummary} [detected: ${JSON.stringify(p.hint.detectedPhrase)}]`;
  if (p.watching) return `Planning fallacy: watching this query (reason: ${p.watching.reason}). ${p.watching.suggestion} [detected: ${JSON.stringify(p.watching.detectedPhrase)}]`;
  return null;
}

function cutoffLine(shown: number, s: api.RecallSuppressionSummary): string | null {
  const clauses: string[] = [];
  // The residual covers rank, budget and limit drops alike, and fires with no --limit at all.
  if (s.droppedByBudget > 0) clauses.push(`${s.droppedByBudget} not shown (rank, budget or limit)`);
  if (s.droppedPreRank > 0) clauses.push(`${s.droppedPreRank} filtered pre-rank`);
  if (s.summarySubstitutionsAdded > 0) clauses.push(`${s.summarySubstitutionsAdded} summary substitutions added`);
  if (s.freshTailAdded > 0) clauses.push(`${s.freshTailAdded} fresh-tail added`);
  if (s.suppressedByInterference > 0) clauses.push(`${s.suppressedByInterference} suppressed by interference`);
  return clauses.length > 0 ? `Cutoff: showing ${shown} of ${s.totalCandidates} candidates; ${clauses.join('; ')}.` : null;
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
  // Rolled up so the cross-repo summary reports the gate too. Each repo
  // already prints its own count inside learnFromRepo, but the aggregate
  // line showed only what was ADDED - and the point of this change is
  // that a dropped subject is never invisible.
  let totalLowInfo = 0;
  const seedDays = parseInt(String(flags['days'] ?? '365'), 10);
  const machine = currentMachine();
  const agentImport = emptyReport();

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
      totalLowInfo += result.lowInfo;
    }
    if (!flags['no-learn']) mergeReports(agentImport, importProjectMemories(repoHippo, { machine }));

    const status = alreadyExists ? 'existing' : 'new';
    const entries = loadAllEntries(repoHippo);
    console.log(`  ${name.padEnd(25)} ${status.padEnd(10)} ${entries.length} memories${added > 0 ? ` (+${added} from git)` : ''}`);
  }

  console.log(`\n${repos.length} repositories, ${totalLessons} new lessons learned` +
    (totalLowInfo > 0 ? `, ${totalLowInfo} low-information subject(s) dropped` : '') +
    '.');
  if (!flags['no-learn']) {
    mergeReports(agentImport, importUserMemories(globalRoot, { machine }));
    printAgentImport(agentImport, '');
  }
  console.log(`Global store: ${globalRoot}`);
  if (initInstallsIntegrations(flags)) {
    // User-level hooks only: a hippo block in each repo's CLAUDE.md or AGENTS.md would leave a diff in every repo.
    const agents = detectAgentHooks(repos);
    if (agents.length === 0) {
      console.log('   No agent config found in these repositories. Run `hippo setup` to add hooks for the agents on this machine.');
    }
    installUserLevelHooks(agents, true);
  }
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
    } else {
      initGlobal();
      console.log('Initialized global Hippo store at', globalRoot);
    }
    if (!flags['no-learn']) printAgentImport(importUserMemories(globalRoot, { machine: currentMachine() }));
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
  }

  // Every run, not only the first: an agent's notes change between inits.
  if (!flags['no-learn']) printAgentImport(importForStore(hippoRoot, { machine: currentMachine() }));
}

/** Every write init makes into agent config (instruction blocks, hooks, plugins) is an automatic integration, so one switch skips them all. */
function initInstallsIntegrations(flags: Record<string, string | boolean | string[]>): boolean {
  if (flags['no-hooks']) return false;
  if (process.env.HIPPO_SKIP_AUTO_INTEGRATIONS !== '1') return true;
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
    fs.writeFileSync(targetPath, existing + sep + block + '\n', 'utf8');
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
  fs.writeFileSync(filePath, `${text.slice(0, start)}${eol}${HOOKS[owner].content.replace(/\n/g, eol)}${eol}${text.slice(end)}`, 'utf8');
  console.log(`   Refreshed the ${owner} hippo block in ${name}`);
}

/** Claude Code settings hooks, Codex's hooks.json and the OpenCode plugin, under the home directory; idempotent, so re-running init adds newer hooks. */
function installUserLevelHooks(agents: readonly string[], codexHint: boolean): void {
  for (const hook of agents) {
    // The Codex capture wrapper swaps the codex launcher binary, so init only points at the opt-in (issue #133).
    if (hook === 'codex' && codexHint && !isCodexWrapperInstalled()) {
      console.log('   Codex detected. To capture Codex sessions: hippo hook install codex');
    }
    // Checked first so init never creates ~/.codex on a machine without Codex.
    if (hook === 'codex' && isCodexPresent()) installCodexMemoryHooks('   ');

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

// `requested` is what the caller typed; `all` adds path and scope tags from this process's cwd and env.
interface RememberTags {
  requested: string[];
  all: string[];
}

// Shared by the direct write and the routed request so both store the same tags.
function rememberTags(
  flags: Record<string, string | boolean | string[]>,
  cwd: string,
): RememberTags {
  const requested: string[] = Array.isArray(flags['tag']) ? [...(flags['tag'] as string[])] : [];
  if (flags['error']) requested.push('error');
  const all = [...requested];
  for (const pt of extractPathTags(cwd)) {
    if (!all.includes(pt)) all.push(pt);
  }
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const activeScope = explicitScope || detectScope();
  if (activeScope) {
    const scopeTag = `scope:${activeScope}`;
    if (!all.includes(scopeTag)) all.push(scopeTag);
  }
  return { requested, all };
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

  const { requested: requestedTags, all: allTags } = rememberTags(flags, process.cwd());

  // Resolve explicit confidence flag (default: 'verified' for manual remember)
  let confidence: ConfidenceLevel = 'verified';
  if (flags['observed']) confidence = 'observed';
  if (flags['inferred']) confidence = 'inferred';
  if (flags['verified']) confidence = 'verified';

  // Schema fit needs the store, which the routed request has no access to, so it stays here.
  const existing = loadAllEntries(targetRoot, resolveTenantId({}));
  const schemaFit = computeSchemaFit(text, requestedTags, existing);

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
  const rememberConfig = loadConfig(targetRoot);

  const entry = createMemory(text, {
    layer: Layer.Episodic,
    tags: allTags,
    pinned: Boolean(flags['pin']),
    source: useGlobal ? 'cli-global' : 'cli',
    confidence,
    schema_fit: schemaFit,
    kind: kindFlag as ('raw' | 'distilled' | 'superseded' | 'archived' | undefined),
    scope: scopeForEnvelope,
    owner: ownerFlag,
    artifact_ref: artifactRefFlag,
    tenantId,
    baseHalfLifeDays: rememberConfig.defaultHalfLifeDays,
  });

  // Salience gate: decide if this memory is worth storing
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
  for (const w of vetSecrets(entry.content, entry.tags, false).warnings) console.error(`Warning: ${w}`);

  void embedMemory(targetRoot, entry);

  const config = loadConfig(targetRoot);
  const shouldExtract = flags['extract'] || config.extraction.enabled === true;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

  if (shouldExtract && apiKey) {
    try {
      const { extractFacts, storeExtractedFacts } = await import('./extract.js');
      const facts = await extractFacts(entry.content, {
        apiKey,
        model: config.extraction.model,
        onError: (msg) => console.error(`  (extraction failed: ${msg})`),
      });
      if (facts.length > 0) {
        storeExtractedFacts(targetRoot, entry, facts);
        console.error(`  extracted ${facts.length} fact(s)`);
      }
    } catch (err) {
      // Extraction is best-effort: report it, never block remember.
      console.error(`  (extraction failed: ${err instanceof Error ? err.message : String(err)})`);
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

  const layer = typeof flags['layer'] === 'string' ? (flags['layer'] as Layer) : undefined;
  const rawTags = flags['tag'];
  const tags = Array.isArray(rawTags)
    ? (rawTags as string[]).map((t) => String(t))
    : typeof rawTags === 'string'
      ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
  const pinned = flags['pin'] === true || old.pinned;

  const newEntry = createSuccessor(old, newContent, {
    tenantId: old.tenantId,
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
    layer,
    tags,
    pinned,
  });

  // AT1: write the SUCCESSOR first. The rejection guard fires on the new
  // content — if it refuses, nothing has been mutated yet (the old ordering
  // committed old.superseded_by before the guarded new write, leaving a
  // dangling pointer to an id that was never created). If the old-row write
  // below fails instead, the new row exists unpointered — an orphan
  // successor, strictly less harmful than a dangling pointer. NOTE: unlike
  // api.supersede (whose CAS + insert commit in ONE transaction), this CLI
  // path is two independent writes and stays non-atomic; write order is its
  // only ordering guarantee.
  try {
    writeEntry(hippoRoot, newEntry);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  old.superseded_by = newEntry.id;
  writeEntry(hippoRoot, old);
  emitCliAudit(hippoRoot, 'supersede', oldId, { newId: newEntry.id });

  console.log(`Superseded ${oldId} → ${newEntry.id}`);
}

/** A flag value, or the deferred error that rejects it. */
interface ParsedFlag<T> { value?: T; fail?: () => never }

/** A flag the ranking stages read, rejected where the old mid-pipeline check printed its error. */
interface LateFlagError { stage: RankStage; fail: () => never }

interface RecallLateFlags {
  graphHops?: RecallGraphHops;
  reranker?: RecallReranker;
  salienceThreshold?: number;
  outcome?: string;
  layer?: string;
  error?: LateFlagError;
}

function failWith(message: string): () => never {
  return () => {
    console.error(message);
    process.exit(1);
  };
}

/** `--graph-stream` implies rrf fusion as well as the graph stream; the CLI fuses the local store only. */
function parseGraphStreamFlags(flags: CliFlags): RecallGraphStream {
  let hops: number | undefined;
  if (flags['graph-hops'] !== undefined) {
    if (typeof flags['graph-hops'] === 'boolean') failWith(`--graph-hops requires an integer value 1..${MAX_HOPS} (e.g. --graph-hops 2).`)();
    const h = Number(flags['graph-hops']);
    if (!Number.isInteger(h) || h < 1 || h > MAX_HOPS) {
      failWith(`Invalid --graph-hops: "${String(flags['graph-hops'])}". Must be an integer 1..${MAX_HOPS}.`)();
    }
    hops = h;
  }
  let seeds: number | undefined;
  if (flags['graph-seeds'] !== undefined) {
    if (typeof flags['graph-seeds'] === 'boolean') failWith('--graph-seeds requires a positive integer value (e.g. --graph-seeds 10).')();
    const s = Number(flags['graph-seeds']);
    if (!Number.isInteger(s) || s < 1) failWith(`Invalid --graph-seeds: "${String(flags['graph-seeds'])}". Must be a positive integer.`)();
    seeds = s;
  }
  return { hops, seeds };
}

function parseHopsFlags(flags: CliFlags): ParsedFlag<RecallGraphHops> {
  if (flags['hops'] === undefined) return {};
  // A value-less `--hops` parses as true, and Number(true) === 1 would silently run a 1-hop expansion.
  if (typeof flags['hops'] === 'boolean') return { fail: failWith(`--hops requires an integer value 0..${MAX_HOPS} (e.g. --hops 1).`) };
  const hops = Number(flags['hops']);
  if (!Number.isInteger(hops) || hops < 0 || hops > MAX_HOPS) {
    return { fail: failWith(`Invalid --hops: "${String(flags['hops'])}". Must be an integer 0..${MAX_HOPS}.`) };
  }
  const raw = flags['max-neighbors'];
  if (raw === undefined) return { value: { hops, maxNeighbors: DEFAULT_MAX_NEIGHBORS } };
  if (typeof raw === 'boolean') return { fail: failWith(`--max-neighbors requires an integer value 1..200.`) };
  const maxNeighbors = Number(raw);
  if (!Number.isInteger(maxNeighbors) || maxNeighbors < 1 || maxNeighbors > 200) {
    return { fail: failWith(`Invalid --max-neighbors: "${String(raw)}". Must be an integer 1..200.`) };
  }
  return { value: { hops, maxNeighbors } };
}

function parseRerankerFlag(flags: CliFlags): ParsedFlag<RecallReranker> {
  const name = flags['reranker'] !== undefined ? String(flags['reranker']).trim() : '';
  let fn: RerankerFn | null;
  try {
    fn = getReranker(name);
  } catch (err) {
    // An unknown name throws to the top-level handler, as it did when the lookup sat mid-pipeline.
    return { fail: () => { throw err; } };
  }
  if (!fn) return {};
  const topK = flags['reranker-top-k'] !== undefined
    ? parseInt(String(flags['reranker-top-k']), 10)
    : name === 'jev' ? JEV_DEFAULT_TOP_K : 50;
  return { value: { fn, topK } };
}

function parseSalienceFlag(flags: CliFlags): ParsedFlag<number> {
  const raw = flags['salience-threshold'];
  if (raw === undefined) return {};
  const threshold = Number(raw);
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return { fail: failWith(`Invalid --salience-threshold: "${String(raw)}". Must be a positive number.`) };
  }
  return { value: threshold };
}

function parseChoiceFlag(flags: CliFlags, name: 'outcome' | 'layer', valid: readonly string[]): ParsedFlag<string> {
  const value = flags[name] !== undefined ? String(flags[name]).trim() : '';
  if (!value) return {};
  if (!valid.includes(value)) return { fail: failWith(`Invalid --${name}: "${value}". Must be one of: ${valid.join(', ')}.`) };
  return { value };
}

/** Parses every flag a ranking stage reads; the first invalid one in pipeline order becomes `error`. */
function parseRecallLateFlags(flags: CliFlags): RecallLateFlags {
  const graphHops = parseHopsFlags(flags);
  const reranker = parseRerankerFlag(flags);
  const salience = parseSalienceFlag(flags);
  const outcome = parseChoiceFlag(flags, 'outcome', ['success', 'failure', 'partial']);
  const layer = parseChoiceFlag(flags, 'layer', Object.values(Layer));
  const staged: ReadonlyArray<readonly [RankStage, (() => never) | undefined]> = [
    ['expand', graphHops.fail], ['rerank', reranker.fail], ['salience', salience.fail], ['outcome', outcome.fail], ['layer', layer.fail],
  ];
  let error: LateFlagError | undefined;
  for (const [stage, fail] of staged) {
    if (fail) { error = { stage, fail }; break; }
  }
  return {
    graphHops: graphHops.value,
    reranker: reranker.value,
    salienceThreshold: salience.value,
    outcome: outcome.value,
    layer: layer.value,
    error,
  };
}

async function cmdRecall(
  hippoRoot: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseBudgetFlag(flags['budget'], 4000);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const showWhy = Boolean(flags['why']);
  const includeSuperseded = Boolean(flags['include-superseded']);
  const asOf = parseAsOfFlag(flags);
  const globalRoot = getGlobalRoot();
  const primaryIsGlobal = isGlobalStoreRoot(hippoRoot);
  // Cross-tenant rows must never surface, so the tenant is resolved once and threaded through every load.
  const tenantId = resolveTenantId({});
  // The explicit --scope is the filter input; the detected scope only boosts, so auto-detection never filters.
  const recallExplicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  const config = loadConfig(hippoRoot);
  const minResults = flags['min-results'] !== undefined
    ? parseInt(String(flags['min-results']), 10)
    : undefined;
  const recallActiveScope = recallExplicitScope || detectScope();
  const graphStream = flags['graph-stream'] === true ? parseGraphStreamFlags(flags) : undefined;
  const late = parseRecallLateFlags(flags);
  const goalTag = flags['goal'] !== undefined ? String(flags['goal']).trim() : '';
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : process.env.HIPPO_SESSION_ID ?? ''
  ).trim();

  // Engines spend the budget on the text each result prints as, less the header, so selection and print agree.
  const localIndex = loadIndex(hippoRoot);
  const globalOn = isInitialized(globalRoot);
  const entryText = (r: SearchResult): string => recallEntryText(r, query, showWhy, primaryIsGlobal || (globalOn && !localIndex.entries[r.entry.id]));
  const printCost = (r: SearchResult): number => printedTokens(entryText(r));
  const entryBudget = Math.max(0, budget - printedTokens(recallHeading(budget, budget, query)));

  const rank = await rankRecall(
    { hippoRoot, globalRoot: globalRoot !== hippoRoot && globalOn ? globalRoot : undefined, tenantId, note: (line) => console.error(line) },
    {
      query, budget: entryBudget, cost: printCost, limit, why: showWhy, includeSuperseded, asOf,
      explicitScope: recallExplicitScope, activeScope: recallActiveScope,
      search: { ...engineFlags(flags, config), multihop: flags['multihop'] === true || config.multihop.enabled, graphStream, minResults, explain: false },
      graphHops: late.graphHops,
      evcAdaptive: Boolean(flags['evc-adaptive']),
      filterConflicts: Boolean(flags['filter-conflicts']),
      valueAware: Boolean(flags['value-aware']),
      rerankUtility: Boolean(flags['rerank-utility']),
      reranker: late.reranker,
      goalTag,
      sessionId,
      salienceThreshold: late.salienceThreshold,
      outcome: late.outcome,
      layer: late.layer,
      haltBefore: late.error?.stage,
    },
  );
  if (rank.goalRecallLog.length > 0) {
    const dbForGoals = openHippoDb(hippoRoot);
    try {
      writeGoalRecallLog(dbForGoals, rank.goalRecallLog);
    } finally {
      closeHippoDb(dbForGoals);
    }
  }
  late.error?.fail();
  const {
    localEntries,
    globalEntries,
    totalCandidates: totalCandidatesCountCmd,
    droppedPreRank: droppedPreRankCountCmd,
    graphAdded: graphAddedCountCmd,
  } = rank;
  let results = rank.results;

  // Continuity assembly (--continuity). Lives BEFORE the zero-result branch
  // so a no-match query with active continuity state still returns a useful
  // resume packet. Same three tenant-scoped store helpers as api.recall.
  const includeContinuity = Boolean(flags['continuity']);
  let activeSnapshot: TaskSnapshot | null = null;
  let sessionHandoff: SessionHandoff | null = null;
  let recentSessionEvents: SessionEvent[] = [];
  if (includeContinuity && !primaryIsGlobal) {
    const rawSnapshot = loadActiveTaskSnapshot(hippoRoot, tenantId);
    const sessionId = rawSnapshot?.session_id ?? undefined;
    const rawHandoff = sessionId
      ? loadLatestHandoff(hippoRoot, tenantId, sessionId)
      : null;
    const rawEvents = sessionId
      ? listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, limit: 5 })
      : [];
    // W1: was its own copy of passesScopeFilterForRecall (cloned 3x);
    // calls the shared helper directly now (recallActiveScope merges
    // --scope and detectScope()).
    const effectiveScope = recallActiveScope || undefined;
    const rowScope = (
      r: { scope?: string | null } | null | undefined,
    ): string | null => r?.scope ?? null;
    activeSnapshot =
      rawSnapshot && passesScopeFilterForRecall(rowScope(rawSnapshot), effectiveScope) ? rawSnapshot : null;
    sessionHandoff =
      rawHandoff && passesScopeFilterForRecall(rowScope(rawHandoff), effectiveScope) ? rawHandoff : null;
    recentSessionEvents = rawEvents.filter((e) => passesScopeFilterForRecall(rowScope(e), effectiveScope));
  }

  // Sections print ahead of the memories, so they are paid first, after the header; one that does not fit is dropped.
  const sectionBudget = budget - printedTokens(recallHeading(budget, budget, query));
  let left = sectionBudget;
  const pays = (tokens: number): boolean => { if (tokens > left) return false; left -= tokens; return true; };
  if (activeSnapshot && !pays(printedTokens(snapshotText(activeSnapshot)))) activeSnapshot = null;
  if (sessionHandoff && !pays(printedTokens(handoffText(sessionHandoff)))) sessionHandoff = null;
  if (recentSessionEvents.length > 0 && !pays(printedTokens(sessionTrailText(recentSessionEvents)))) recentSessionEvents = [];
  const continuityTokens = sectionBudget - left;
  const hasContinuity = activeSnapshot !== null || sessionHandoff !== null || recentSessionEvents.length > 0;

  // J3.2: the baserate hint depends on the query alone; its audit is pipeline-local (actor 'cli').
  const cmdPlanningFallacyOutput = computePlanningFallacyOutput(hippoRoot, tenantId, query, { actor: 'cli' });
  const planText = planningLine(cmdPlanningFallacyOutput);
  const showPlan = planText !== null && pays(printedTokens(`${planText}\n`));
  const cmdPlanningFallacyHint = showPlan ? cmdPlanningFallacyOutput.hint ?? null : null;
  const cmdPlanningFallacyWatching = showPlan ? cmdPlanningFallacyOutput.watching ?? null : null;

  // The first --min-results are kept whatever they cost (the documented exception); the rest skip and continue.
  const floor = minResults ?? 1;
  const fitted = fitBudget(results, left, floor, printCost);
  // Copies go after every cut, so a merged row the budget drops never hides its sources.
  const shown = (n: number): SearchResult[] => dropHeldCopies(fitted.slice(0, n), (r) => r.entry);
  let kept = fitted.length;
  results = shown(kept);

  // J1, J2 and C5: each pipeline computes its hints over the list it returns, so they follow the list as it shrinks.
  // HIPPO_ANCHORING=off and HIPPO_AVAILABILITY=off skip the work entirely.
  const anchorRing = biasHintEnabled('anchoring') && sessionId
    ? getOrCreateRing(sessionRecallHistoryCli, buildSessionKey(tenantId, sessionId))
    : null;
  const queryHash = hashQueryText(query);
  const availabilityPool = biasHintEnabled('availability')
    ? [...localEntries, ...globalEntries].map((e) => ({ id: e.id, created: e.created }))
    : null;
  const hintsFor = (list: SearchResult[], held: number) => {
    const anchoring = anchorRing ? detectAnchoring(snapshotRing(anchorRing), queryHash, list[0]?.entry.id ?? null) : null;
    const availability = availabilityPool
      ? detectAvailabilityBias({ topK: list.map((r) => ({ id: r.entry.id, created: r.entry.created })), pool: availabilityPool })
      : null;
    const summary = api.buildSuppressionSummary({
      // The published total includes graph-surfaced rows, so total == preRank + byBudget + returned holds for callers.
      totalCandidates: totalCandidatesCountCmd + graphAddedCountCmd,
      droppedPreRank: droppedPreRankCountCmd + held,
      droppedByBudget: Math.max(0, totalCandidatesCountCmd + graphAddedCountCmd - droppedPreRankCountCmd - held - list.length),
      summarySubstitutionsAdded: 0,
      freshTailAdded: 0,
      suppressedByInterference: anchoring?.reason === 'memory_dominance' ? 1 : 0, // a query_repeat is a re-ask, not competition
    });
    return { anchoring, availability, summary };
  };
  const printContinuity = (): void => {
    if (activeSnapshot) printActiveTaskSnapshot(activeSnapshot);
    if (sessionHandoff) printHandoff(sessionHandoff);
    if (recentSessionEvents.length > 0) printSessionEvents(recentSessionEvents);
  };
  const renderRecall = (list: SearchResult[], h: ReturnType<typeof hintsFor>): string => settleTokens((t) => captureConsole(() => {
    if (list.length === 0) {
      // The hint still prints when nothing matched, so the agent sees its track record.
      if (showPlan) { console.log(planText); console.log(); }
      if (hasContinuity) {
        printContinuity();
        console.log(`(no memories matched "${query}")`);
      } else {
        console.log('No memories found for:', query);
      }
      return;
    }
    printContinuity();
    // Anchoring is the stronger pull, so it prints first; the Cutoff line sits above the list, where a reader sees it.
    if (h.anchoring) { console.log(`[anchored_on: ${h.anchoring.memoryId}] ${h.anchoring.summary}`); console.log(); }
    if (h.availability) {
      console.log(`Availability bias (${h.availability.recentCount}/${h.availability.returnedCount} recent): ${h.availability.summary}`);
      console.log();
    }
    if (showPlan) { console.log(planText); console.log(); }
    const cutoff = showWhy ? cutoffLine(list.length, h.summary) : null;
    if (cutoff) { console.log(cutoff); console.log(); }
    console.log(recallHeading(list.length, t, query));
    for (const r of list) console.log(entryText(r));
  }));

  let hints = hintsFor(results, kept - results.length);
  let recallText = renderRecall(results, hints);
  // The hints, Cutoff line and header vary with the list, so the lowest-ranked entry goes until the whole block fits.
  while (kept > floor && estimateTokens(recallText) > budget) {
    kept--;
    results = shown(kept);
    hints = hintsFor(results, kept - results.length);
    recallText = renderRecall(results, hints);
  }
  const { anchoring: cmdAnchoringHint, availability: cmdAvailabilityHint, summary: cmdSuppressionSummary } = hints;

  if (anchorRing) {
    // Appended after every detect: anchoredOn feeds the cooldown for the next recall on this session.
    appendRecall(anchorRing, queryHash, results[0]?.entry.id ?? null, cmdAnchoringHint?.memoryId);
  } else if (biasHintEnabled('anchoring')) {
    // SHA-256/16 per the recall-audit convention; hashQueryText is FNV-1a and brute-forceable on short queries.
    emitCliAudit(hippoRoot, 'recall_anchor_skipped_no_session', undefined, auditQueryFields(query));
  }
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
  if (cmdAvailabilityHint) {
    emitCliAudit(hippoRoot, 'recall_availability_detected', undefined, {
      recent_fraction: cmdAvailabilityHint.recentFraction,
      older_passed_over: cmdAvailabilityHint.olderCandidatesPassedOver,
      returned_count: cmdAvailabilityHint.returnedCount,
    });
  }

  // A5 audit: one 'recall' event per query, before the early-empty return, in every participating store.
  const recallMetadata: Record<string, unknown> = {
    ...auditQueryFields(query),
    results: results.length,
  };
  emitCliAudit(hippoRoot, 'recall', undefined, recallMetadata);
  if (isInitialized(globalRoot) && globalRoot !== hippoRoot) {
    emitCliAudit(globalRoot, 'recall', undefined, recallMetadata);
  }

  // TE0 token ledger: books the block this recall prints, on whichever exit it takes.
  const emit = (text: string): void => {
    withLedgerDb(hippoRoot, (db) => recordTokenUse(db, {
      tenantId,
      sessionId: hostSessionId() ?? null,
      surface: 'recall',
      event: 'inject',
      items: results.length,
      tokens: estimateTokens(text),
    }));
    console.log(text);
  };

  if (results.length === 0) {
    // LC1 F1 structural fix (docs/plans/2026-08-02-lc1-recall-trace-persistence.md):
    // trace the zero-result recall too (result_count 0, no result rows) so
    // a query that reveals a coverage gap still lands in the training
    // corpus. Deliberately does NOT touch `localIndex` at all — this path
    // never advances last_retrieval_ids (no memories to update), and
    // writeRecallTraceAtRoot no longer stamps last_trace_id on its own
    // (that only happens via the caller folding the returned id into
    // localIndex before a SAME saveIndex call, which this path never
    // reaches). By construction the two can't desync. Fail-soft
    // internally; never throws.
    writeRecallTraceAtRoot(hippoRoot, {
      tenantId,
      sessionId: sessionId || hostSessionId() || null,
      pipeline: 'cli',
      query,
      explainMode: showWhy,
      results: [],
    });

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
      emit(JSON.stringify(out));
      return;
    }
    emit(recallText);
    return;
  }

  const retrievedIds = results.map((r) => r.entry.id);
  const strengthenedHere = strengthenRetrieved(hippoRoot, retrievedIds);
  if (isInitialized(globalRoot)) strengthenRetrieved(globalRoot, retrievedIds.filter((id) => !strengthenedHere.has(id)));

  // Track last retrieval IDs for outcome command
  localIndex.last_retrieval_ids = retrievedIds;

  // LC1 F1 structural fix (docs/plans/2026-08-02-lc1-recall-trace-persistence.md):
  // ONE trace at hippoRoot (where last_retrieval_ids and outcome
  // attribution live). Write the trace FIRST, then fold its id into
  // `localIndex` so the SAME saveIndex call below persists
  // last_retrieval_ids + last_trace_id atomically (LOCKSTEP INVARIANT —
  // see writeRecallTraceAtRoot JSDoc). The globalRoot audit emit
  // (emitCliAudit above) is untouched — no second trace row. Fail-soft
  // internally; never throws.
  const traceId = writeRecallTraceAtRoot(hippoRoot, {
    tenantId,
    sessionId: sessionId || hostSessionId() || null,
    pipeline: 'cli',
    query,
    explainMode: showWhy,
    results: results.map((r) => ({
      memoryId: r.entry.id,
      score: r.score,
      rerankSteps: r.rerankTrace,
    })),
  });
  localIndex.last_trace_id = traceId !== null ? String(traceId) : null;
  saveIndex(hippoRoot, localIndex);

  updateStats(hippoRoot, { recalled: results.length });

  if (asJson) {
    const output = results.map((r) => {
      const isGlobal = primaryIsGlobal || (isInitialized(globalRoot) && !localIndex.entries[r.entry.id]);
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
        const facets = confidenceFacets(r.entry);
        base.confidence = facets.tier;
        base.aged_out = facets.agedOut;
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
    emit(JSON.stringify(jsonOut));
    return;
  }
  emit(recallText);
}

/** The SQL predicate drops denied rows before the window, so an unscoped probe counts what the policy hides. */
function noteScopeHidden(hippoRoot: string, globalRoot: string | undefined, query: string, tenantId: string, requested: string | undefined): void {
  const probe = [
    ...loadSearchEntries(hippoRoot, query, undefined, tenantId),
    ...(globalRoot ? loadSearchEntries(globalRoot, query, undefined, tenantId) : []),
  ];
  // Window-capped, so the count is a floor on large stores; fine for a "why is my row missing" hint.
  const hidden = probe.filter((e) => !api.passesCliRecallScopeFilter(e.scope ?? null, requested)).length;
  if (hidden > 0) {
    console.error(`[note] ${hidden} candidate${hidden === 1 ? '' : 's'} hidden by recall scope policy (pass an explicit --scope to inspect).`);
  }
}

async function cmdExplain(
  hippoRoot: string,
  query: string,
  flags: CliFlags
): Promise<void> {
  requireInit(hippoRoot);

  const budget = parseBudgetFlag(flags['budget'], 4000);
  const limit = parseLimitFlag(flags['limit']);
  const asJson = Boolean(flags['json']);
  const includeSuperseded = Boolean(flags['include-superseded']);
  const asOf = parseAsOfFlag(flags);
  const globalRoot = getGlobalRoot();
  const tenantId = resolveTenantId({});
  // Explain shows what recall would see, so it applies the same scope rule.
  const explicitScope = flags['scope'] !== undefined ? String(flags['scope']).trim() : null;
  // Unlike recall, explain reads the global store whenever it exists, even when it is the local root.
  const explainGlobalOn = isInitialized(globalRoot);
  noteScopeHidden(hippoRoot, explainGlobalOn ? globalRoot : undefined, query, tenantId, explicitScope || undefined);

  const config = loadConfig(hippoRoot);
  const engine = engineFlags(flags, config);
  // Priced as recall prints each result, so explain returns what recall's engines would.
  const explainIndex = loadIndex(hippoRoot);
  const cost = (r: SearchResult): number =>
    printedTokens(recallEntryText(r, query, false, explainGlobalOn && !explainIndex.entries[r.entry.id]));
  const entryBudget = Math.max(0, budget - printedTokens(recallHeading(budget, budget, query)));

  const rank = await rankRecall(
    { hippoRoot, globalRoot: explainGlobalOn ? globalRoot : undefined, tenantId },
    {
      query, budget: entryBudget, cost, limit, includeSuperseded, asOf,
      explicitScope, activeScope: explicitScope || detectScope(),
      search: { ...engine, multihop: false, explain: true },
    },
  );
  const hasGlobal = rank.globalEntries.length > 0;
  const modeUsed: 'physics' | 'searchBothHybrid' | 'hybrid' = engine.usePhysics && !hasGlobal
    ? 'physics'
    : hasGlobal ? 'searchBothHybrid' : 'hybrid';
  const results = dropHeldCopies(rank.results, (r) => r.entry);

  const candidates = rank.localEntries.length + rank.globalEntries.length;

  if (asJson) {
    const output = results.map((r, rank) => ({
      rank: rank + 1,
      id: r.entry.id,
      layer: r.entry.layer,
      confidence: confidenceFacets(r.entry).tier,
      aged_out: confidenceFacets(r.entry).agedOut,
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
      if (b.churnStaleMultiplier !== 1) console.log(`    churn:     x${fmt(b.churnStaleMultiplier, 2)}  (tagged 'churn-stale')`);
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
      try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch {
        console.error(`Warning: eval baseline ${baselinePath} is unreadable; running without it.`);
      }
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
    tenantId: resolveTenantId({}),
    baseHalfLifeDays: loadConfig(hippoRoot).defaultHalfLifeDays,
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

  const now = evalNow();
  const strength = calculateStrength(entry, now);
  const halfLife = entry.half_life_days;
  const rewardFactor = calculateRewardFactor(entry);
  const effHalfLife = halfLife * rewardFactor;
  const createdMs = new Date(entry.created).getTime();
  const ageDays = (now.getTime() - createdMs) / 86_400_000;
  const lastMs = new Date(entry.last_retrieved).getTime();
  const sinceLast = (now.getTime() - lastMs) / 86_400_000;
  const facets = confidenceFacets(entry, now);
  const conf = confidenceLabel(entry, now).text;

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
      confidence: facets.tier,
      aged_out: facets.agedOut,
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
  console.log(`Layer:     ${entry.layer.padEnd(10)} Confidence: ${conf.padEnd(14)} Pinned: ${entry.pinned ? 'yes' : 'no'}${entry.starred ? '  Starred: yes' : ''}`);
  console.log(`Tags:      ${entry.tags.join(', ') || '(none)'}`);
  console.log(`Created:   ${entry.created}  (${fmt(ageDays, 1)} days ago)`);
  console.log();
  console.log(`Strength trajectory:`);
  console.log(`  now:        ${fmt(strength, 3)}`);
  console.log(`  in 30 days: ${fmt(projectedAt(30), 3)}`);
  console.log(`  in 90 days: ${fmt(projectedAt(90), 3)}`);
  console.log(`  half-life:  ${fmt(halfLife, 1)}d (stored) x ${fmt(rewardFactor, 2)} reward = ${fmt(effHalfLife, 1)}d effective`);
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

function cmdDedup(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const dryRun = Boolean(flags['dry-run']);
  if (flags['threshold'] !== undefined) {
    console.error('hippo dedup: --threshold is ignored; a duplicate is the same text apart from spacing.');
  }

  const entries = loadAllEntries(hippoRoot);
  console.log(`Scanning ${entries.length} memories for duplicates (same text apart from spacing)${dryRun ? ' (dry run)' : ''}...\n`);

  const result = deduplicateStore(hippoRoot, { dryRun });

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

/** Prints the SessionEnd sleep log, then clears it. Stderr, because Claude Code adds
 *  SessionStart stdout to the model's context and this log is for the user. */
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
    console.error('=== Previous session hippo consolidation ===');
    process.stderr.write(content);
    if (!content.endsWith('\n')) console.error();
    console.error('===========================================');
  }

  if (!flags['keep']) {
    try { fs.unlinkSync(logPath); } catch { /* non-fatal */ }
  }
}

/**
 * SessionStart(compact) injector. Prints the active task snapshot + recent
 * session trail so working state that would otherwise be lost to
 * compaction summarisation survives into the new context window. No pinned
 * memories here — the UserPromptSubmit hook already re-injects those every
 * turn, so duplicating them here would double token cost for nothing.
 *
 * Same exit-0/crash-safety contract as `hippo pre-compact` (critic round
 * 2): every path exits 0. A malformed payload or a store read failure
 * degrades to empty stdout, never a thrown error — a failing SessionStart
 * hook must not pollute session startup.
 */
// X8: session-event content is capped at print time only — the shared
// printSessionEvents stays untouched for every other caller.
const COMPACT_RESUME_EVENT_CONTENT_CAP = 400;

// A snapshot older than this was not written for this compaction (pre-compact skipped), so restoring it is stale, not a resume.
const COMPACT_RESUME_MAX_AGE_MS = 15 * 60_000;

function cmdCompactResume(hippoRoot: string, stdinText: string | undefined, stdinTimedOut: boolean): void {
  try {
    // X3: gate on the non-exiting isInitialized check before any
    // store-opening call (loadActiveTaskSnapshot/listSessionEvents both
    // call initStore internally, which would silently create a store in a
    // project that never ran `hippo init` — this hook fires globally).
    if (!isInitialized(hippoRoot)) {
      process.exit(0);
    }

    // The matcher is an optimization, not a dependency: older Claude Code
    // that ignores `matcher: 'compact'` would run this on every SessionStart,
    // so we also gate on payload.source here. A payload that parses but
    // carries a different source (e.g. 'startup') means the matcher-based
    // gate failed to apply — stay silent rather than print stale state.
    const nonEmptyStdin = !!stdinText && stdinText.trim() !== '';
    // Without a payload session_id the X5 cross-restore guard below can
    // never fire, so a timed-out empty read must not reach the print path.
    let suppressOutput = stdinTimedOut && !nonEmptyStdin;
    let payloadSessionId: string | null = null;

    if (nonEmptyStdin) {
      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(stdinText!.trim()) as Record<string, unknown>;
      } catch {
        payload = null;
      }
      if (!payload || typeof payload !== 'object') {
        // X13: fail closed on malformed non-empty stdin. The earlier
        // "print on malformed" behavior survives only for TTY/no-stdin
        // manual invocation (nonEmptyStdin is false there, this branch
        // never runs).
        suppressOutput = true;
      } else {
        // Fail closed on structurally incomplete payloads too ({}, [],
        // source missing/non-string): any parsed non-empty payload must say
        // source === 'compact' to print. Real SessionStart payloads always
        // carry source; only the TTY/no-stdin manual path prints without
        // one (codex round 3).
        // A sub-agent's payload carries its parent's session id, so X5 would pass and restore the parent's snapshot into it.
        if (payload.source !== 'compact' || isSubagentPayload(stdinText)) {
          suppressOutput = true;
        }
        if (typeof payload.session_id === 'string' && payload.session_id.trim() !== '') {
          payloadSessionId = payload.session_id;
        }
      }
    }

    // A compaction follows a prompt or SessionStart that booked the arm, so this only reads it.
    if (!suppressOutput && payloadSessionId !== null && inPilotHoldout(hippoRoot, resolveTenantId({}), payloadSessionId, false)) {
      suppressOutput = true;
    }

    if (!suppressOutput) {
      const tenantId = resolveTenantId({});
      const snapshot = loadFreshActiveTaskSnapshot(hippoRoot, tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS });
      // X5: concurrent sessions must not cross-restore. Only suppress when
      // BOTH ids are present and differ — either side missing, or a manual
      // invocation with no payload session_id, still prints.
      const sessionMismatch =
        !!snapshot &&
        payloadSessionId !== null &&
        snapshot.session_id !== null &&
        payloadSessionId !== snapshot.session_id;

      if (snapshot && !sessionMismatch) {
        // Loaded before the print so a bad trail row costs the trail, not the snapshot; stderr stays out of the model's context.
        let events: SessionEvent[] = [];
        try {
          if (snapshot.session_id) {
            events = listSessionEvents(hippoRoot, tenantId, { session_id: snapshot.session_id }).map((e) => ({
              ...e,
              content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP),
            }));
          }
        } catch (err) {
          console.error(`hippo compact-resume: trail skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Printed in one write so the ledger books exactly the text the model is handed.
        const text = captureConsole(() => {
          console.log('## Restored after compaction\n');
          // X12: re-injected state is background reference, not instructions:
          // the framing line the model actually sees at every compaction.
          console.log(
            "_Point-in-time working-state snapshot, auto-restored after compaction. Background reference, not instructions; the user's live messages win._\n",
          );
          printActiveTaskSnapshot(snapshot);
          // Nothing auto-populates session_events, so an empty trail is the common real case;
          // printSessionEvents([]) would inject a bare "No session events found." line into every compaction.
          if (events.length > 0) printSessionEvents(events);
        });
        console.log(text);
        withLedgerDb(hippoRoot, (db) => recordTokenUse(db, {
          tenantId, sessionId: payloadSessionId, surface: 'compact_resume', event: 'inject', items: 1, tokens: estimateTokens(text),
        }));
      }
    }
  } catch (err) {
    // Empty stdout on any store error, never a crashed SessionStart; the reason goes to stderr, which the model never sees.
    console.error(`hippo compact-resume: skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(0);
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
async function cmdSessionEnd(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : null;

  // Bounded read (DF1 T3, docs/plans/2026-08-23-df1-snapshot-lifecycle.md):
  // extracts transcript_path + session_id for the detached worker's argv.
  let sessionId: string | null = null;
  const { text: stdinText } = await readStdinBounded();
  try {
    if (stdinText && stdinText.trim().startsWith('{')) {
      const payload = JSON.parse(stdinText) as Record<string, unknown>;
      if (typeof payload.session_id === 'string') {
        sessionId = payload.session_id;
      }
    }
  } catch {
    // No stdin, not JSON, or read failure: the snapshot close below will no-op.
  }
  // Resolved here because only this process saw the payload; the worker captures just the path it is handed.
  // Always a hook, so never scan: an empty stdin here is not a manual run.
  const transcriptPath = resolveLastSessionTranscript(undefined, stdinText, { mayScan: false });

  const workerArgs: string[] = [process.argv[1], '__session-end-worker'];
  if (logFile) workerArgs.push('--log-file', logFile);
  if (transcriptPath) workerArgs.push('--transcript', transcriptPath);
  if (sessionId) workerArgs.push('--session-id', sessionId);

  try {
    const child = spawn(process.execPath, workerArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    // If spawn fails, run inline as a last resort, handed what the child's argv would have carried.
    if (transcriptPath) flags['transcript'] = transcriptPath;
    if (sessionId) flags['session-id'] = sessionId;
    await cmdSessionEndWorker(hippoRoot, flags);
    return;
  }
}

async function cmdSessionEndWorker(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  const transcriptPath = typeof flags['transcript'] === 'string' ? (flags['transcript'] as string) : undefined;
  const closeLogFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : null;
  const closeSessionId = typeof flags['session-id'] === 'string' ? (flags['session-id'] as string) : null;
  const rereadLog = await bookSessionRereads(hippoRoot, transcriptPath, closeSessionId)
    .catch((err) => [`re-read count failed: ${err instanceof Error ? err.message : String(err)}`]);
  // Sleep starts the log file afresh, so the lines go in after it; on exit too, in case sleep exits the process.
  const flushRereadLog = (): void => { for (const line of rereadLog.splice(0)) appendSessionEndCloseLog(closeLogFile, line); };
  process.once('exit', flushRereadLog);
  // Like the other hooks: project store, else global; a folder with neither must not get one made.
  const store = hookStoreRoot(hippoRoot);
  if (!isInitialized(store)) {
    appendSessionEndCloseLog(closeLogFile, 'skip: no hippo store for this folder or globally', { startFresh: true });
    flushRereadLog();
    return;
  }
  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (isInitialized(hippoRoot)) {
    try {
      await (await import('./cli/sleep.js')).cmdSleep(hippoRoot, flags);
    } catch {
      // sleep errors are already tee'd to the log file via cmdSleep's
      // `[hippo] sleep failed: ...` line. Continue to capture regardless.
    }
  } else {
    appendSessionEndCloseLog(closeLogFile, 'skip sleep: this folder has no store of its own', { startFresh: true });
    logSessionEndImport(closeLogFile, transcriptPath);
  }
  flushRereadLog();
  const digestLog = (message: string): void => appendSessionEndCloseLog(closeLogFile, message);
  const scan = transcriptPath ? readSessionScan(transcriptPath, digestLog) : null;
  try {
    const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined;
    // With no stdin of its own, capture would read this as a manual run and scan every project.
    if (!transcriptPath) {
      appendSessionEndCloseLog(logFile ?? null, 'skip capture: no transcript for this session');
    } else {
      cmdCapture(store, {
        source: 'last-session',
        transcriptPath,
        logFile,
        dryRun: false,
        global: false,
        tenantId: resolveTenantId({}),
        // In the global store, rows would otherwise read as user-global and show up in every project.
        originProject: store === hippoRoot ? undefined : deriveOriginProject(process.cwd()),
        sessionTurns: scan?.turns,
      });
    }
  } catch {
    // Same treatment — the failure line is already in the log.
  }
  recordSessionDigest(hippoRoot, scan, {
    key: closeSessionId || path.basename(transcriptPath ?? '', '.jsonl'),
    tenantId: resolveTenantId({}),
    log: digestLog,
  });

  // DF1 T3: close the ending session's own active task snapshot AFTER
  // sleep+capture complete — neither producer (runPreCompact,
  // `hippo snapshot save`) runs inside session-end, so this can never
  // destroy same-run work. Scoped to `--session-id`: a concurrent session's
  // active snapshot is untouched (closeTaskSnapshotsForSession's own WHERE
  // clause). Absent session id -> no-op plus one log line; session-end is
  // not guaranteed to fire at all (crash, kill -9), so the freshness bound
  // in loadFreshActiveTaskSnapshot is the backstop layer, not this close.
  // Handoff write happens BEFORE the snapshot close below, while the
  // snapshot writeSessionEndHandoff reads is still active.
  if (closeSessionId) {
    try {
      const tenantId = resolveTenantId({});
      const ownSnapshot = loadActiveTaskSnapshot(store, tenantId)?.session_id === closeSessionId;
      // A never-compacted session has no snapshot; read even when it has one, as another session's PreCompact can take the slot before the write.
      const derived = transcriptPath
        ? transcriptWorkingState(transcriptPath, (message) => appendSessionEndCloseLog(closeLogFile, message))
        : null;
      if (!ownSnapshot && !derived) {
        appendSessionEndCloseLog(closeLogFile, 'skip: no snapshot or transcript for session');
      } else {
        const evidence = collectHandoffEvidence(process.cwd(), 'unknown');
        const handoff = writeSessionEndHandoff(store, tenantId, closeSessionId, evidence, derived);
        appendSessionEndCloseLog(
          closeLogFile,
          handoff ? `wrote handoff for session ${closeSessionId}` : `skip: kept the existing handoff for session ${closeSessionId}`,
        );
      }
    } catch (err) {
      // SAFETY: catch clauses bind unknown, but Node/V8 always throws an Error here.
      appendSessionEndCloseLog(closeLogFile, `handoff write failed: ${(err as Error).message}`);
    }
  }
  try {
    if (closeSessionId) {
      const closed = closeTaskSnapshotsForSession(store, resolveTenantId({}), closeSessionId);
      appendSessionEndCloseLog(closeLogFile, `closed ${closed} active snapshot(s) for session ${closeSessionId}`);
    } else {
      appendSessionEndCloseLog(closeLogFile, 'skip: no session_id in SessionEnd payload, active snapshot left untouched');
    }
  } catch (err) {
    appendSessionEndCloseLog(closeLogFile, `snapshot close failed: ${(err as Error).message}`);
  }
}

/** Books the ending session's re-reads in each store its ledger rows can land in (project and global); returns the log lines. */
async function bookSessionRereads(
  hippoRoot: string,
  transcriptPath: string | undefined,
  sessionId: string | null,
): Promise<string[]> {
  if (!transcriptPath || !sessionId) return [];
  let read: TranscriptCalls;
  try {
    read = await readApiCalls(transcriptPath);
  } catch (err) {
    return [`skip re-read count: cannot read the transcript: ${err instanceof Error ? err.message : String(err)}`];
  }
  const roots = new Set([hippoRoot, getGlobalRoot()].filter((root) => isInitialized(root)).map((root) => path.resolve(root)));
  const lines: string[] = [];
  let tokens = 0;
  for (const root of roots) {
    try {
      const db = openHippoDb(root);
      try {
        tokens += recordRereads(db, resolveTenantId({}), sessionId, read.calls);
      } finally {
        closeHippoDb(db);
      }
    } catch (err) {
      lines.push(`re-read count failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const skipped = read.malformed > 0 ? `, ${read.malformed} unparsable transcript lines skipped` : '';
  lines.push(`re-read ${tokens} tokens over ${read.calls.length} model calls for session ${sessionId}${skipped}`);
  return lines;
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
    // The line is already quoted for cmd.exe, so Node must not quote it again; /s strips the outer pair.
    return spawn(
      'cmd.exe',
      ['/d', '/s', '/c', `"${command}"`],
      { cwd, stdio: 'inherit', windowsHide: false, windowsVerbatimArguments: true },
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
  // Codex reads CODEX_HOME at each launch, so resolve it now, not from the install-time metadata.
  const { historyPath } = resolveCodexWrapperPaths();
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

  child.on('exit', async (code, signal) => {
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
      // Awaited so the sleep write can't be killed by the exit calls below.
      try {
        await cmdCodexSessionEndWorker(hippoRoot, {
          'codex-home': path.dirname(historyPath),
          'history-path': historyPath,
          'start-offset': String(startOffsetBytes),
          'started-at': String(startedAtMs),
          'log-file': metadata.logFile,
        });
      } catch {
        // cmdCodexSessionEndWorker already fail-softs internally; this is belt-and-braces.
      }
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

async function cmdCodexSessionEndWorker(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): Promise<void> {
  const logFile = typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined;
  // Like the other hooks: project store, else global; a folder with neither must not get one made.
  const store = hookStoreRoot(hippoRoot);
  if (!isInitialized(store)) {
    appendSessionEndCloseLog(logFile ?? null, 'skip: no hippo store for this folder or globally', { startFresh: true });
    return;
  }

  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (isInitialized(hippoRoot)) {
    try {
      await (await import('./cli/sleep.js')).cmdSleep(hippoRoot, logFile ? { 'log-file': logFile } : {});
    } catch {
      // sleep errors are already written via cmdSleep
    }
  } else {
    appendSessionEndCloseLog(logFile ?? null, 'skip sleep: this folder has no store of its own', { startFresh: true });
    logSessionEndImport(logFile ?? null, undefined);
  }

  try {
    const codexHome = typeof flags['codex-home'] === 'string'
      ? (flags['codex-home'] as string)
      : resolveCodexWrapperPaths().codexHome;
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
    // No Codex transcript must not fall through to the scan of Claude Code projects.
    if (!transcriptPath) {
      appendSessionEndCloseLog(logFile ?? null, 'skip capture: no Codex transcript for this session');
      return;
    }

    const digestLog = (message: string): void => appendSessionEndCloseLog(logFile ?? null, message);
    const scan = readSessionScan(transcriptPath, digestLog);
    const captureOpts: CaptureOptions = {
      source: 'last-session',
      transcriptPath,
      logFile,
      dryRun: false,
      global: false,
      tenantId: resolveTenantId({}),
      originProject: store === hippoRoot ? undefined : deriveOriginProject(process.cwd()),
      sessionTurns: scan?.turns,
    };
    try {
      cmdCapture(store, captureOpts);
    } catch {
      // capture path logs its own failures
    }
    // The Codex wrapper passes no session id, so the rollout file names the session.
    recordSessionDigest(hippoRoot, scan, { key: path.basename(transcriptPath, '.jsonl'), tenantId: resolveTenantId({}), log: digestLog });
  } catch {
    // capture path logs its own failures
  }
}

export function shouldAutoRepairCodexWrapper(currentCommand: string, flags: Record<string, string | boolean | string[]>): boolean {
  if (process.env.HIPPO_SKIP_AUTO_INTEGRATIONS === '1') return false;
  if (!['context', 'remember', 'recall', 'sleep', 'capture', 'outcome', 'status', 'init'].includes(currentCommand)) {
    return false;
  }
  if (currentCommand === 'init' && flags['no-hooks'] === true) return false;
  return true;
}

// Repair-only: keeps the wrapper healthy for users who opted in via `hippo
// hook install codex` (a Codex update can restore the real binary over our
// shim). Never first-installs — silently swapping the codex binary on routine
// commands is a consent violation and reads as binary hijacking to
// supply-chain scanners (issue #133).
function maybeRepairCodexWrapper(currentCommand: string, flags: Record<string, string | boolean | string[]>): void {
  if (!shouldAutoRepairCodexWrapper(currentCommand, flags)) return;
  try {
    repairCodexWrapperIfInstalled();
  } catch {
    // best-effort only
  }
}

function cmdStatus(hippoRoot: string): void {
  requireInit(hippoRoot);

  const entries = loadAllEntries(hippoRoot);
  const stats = loadStats(hippoRoot);
  const now = evalNow();

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
  let agedOut = 0;

  for (const e of entries) {
    const s = calculateStrength(e, now);
    byLayer[e.layer] = (byLayer[e.layer] ?? 0) + 1;
    totalStrength += s;
    if (e.pinned) pinned++;
    if (s < 0.2) atRisk++;
    const facets = confidenceFacets(e, now);
    byConfidence[facets.tier] = (byConfidence[facets.tier] ?? 0) + 1;
    if (facets.agedOut) agedOut++;
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
  console.log(`  Aged out:        ${agedOut}  (of the above; excludes pinned, verified)`);
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

// Shared between the forget dispatch and cmdForget so the message can't drift.
const ARCHIVE_REASON_REQUIRED =
  'hippo forget --archive requires --reason "<why>" (recorded on the archive).';

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
      console.error(ARCHIVE_REASON_REQUIRED);
      process.exit(1);
    }
    try {
      api.archiveRaw(ctx, id, reason);
      console.log(`Archived ${id}`);
    } catch (err) {
      console.error(`Could not archive ${id}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  try {
    api.forget(ctx, id);
    console.log(`Forgot ${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/append-only/i.test(msg)) {
      // The delete was refused by the append-only trigger — this is a raw
      // memory, not a missing one. Point the user at the archive path.
      console.error(rawForgetRefusal(id));
    } else if (api.isDormant(ctx, id)) {
      // Sleep moved it to the dormant store: it is not in active memory, so
      // point at the command that owns it.
      console.error(
        `${id} is dormant, not in active memory. Delete it for good: hippo dormant forget ${id} ` +
        `(or bring it back: hippo dormant restore ${id})`,
      );
    } else {
      console.error(`Memory not found: ${id}`);
    }
    process.exit(1);
  }
}

function rawForgetRefusal(id: string): string {
  return `Cannot forget ${id}: it is a raw, append-only memory. Archive it instead: hippo forget ${id} --archive --reason "<why>"`;
}

// Refuses exactly where the real run would, so "Would forget" is a promise, not a guess.
function previewForget(hippoRoot: string, id: string, archive: boolean): void {
  requireInit(hippoRoot);
  const entry = readEntry(hippoRoot, id, resolveTenantId({}));
  if (!entry) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
  if (!archive && entry.kind === 'raw') {
    console.error(rawForgetRefusal(id));
    process.exit(1);
  }
  if (archive && entry.kind !== 'raw') {
    console.error(`Could not archive ${id}: memory ${id} is not raw (kind=${entry.kind})`);
    process.exit(1);
  }
  const snippet = entry.content.length > 80 ? `${entry.content.slice(0, 80)}...` : entry.content;
  console.log(`Would ${archive ? 'archive' : 'forget'} ${id} (dry run, nothing changed): "${snippet}"`);
}

function cmdInspect(hippoRoot: string, id: string): void {
  requireInit(hippoRoot);

  const entry = readEntry(hippoRoot, id, resolveTenantId({}));
  if (!entry) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }

  const now = evalNow();
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
    console.log(`Resolve with: hippo resolve ${conflictId} --keep <memory_id> [--forget] [--reject-loser [--reason "<why>"]]`);
    return;
  }

  const forgetLoser = Boolean(flags['forget']);
  // AT1: --reject-loser tombstones the loser's normalized digest so it
  // cannot be re-asserted later, in addition to removing it (kind-aware).
  // --reason defaults to a conflict-context string when omitted (resolve
  // already has the conflict id + keepId; unlike `hippo reject`, a reason
  // is not strictly required here).
  const rejectLoser = Boolean(flags['reject-loser']);
  const reasonFlag = typeof flags['reason'] === 'string' ? (flags['reason'] as string) : undefined;
  const result = resolveConflict(hippoRoot, conflictId, keepId, forgetLoser, tenantId, {
    rejectLoserValue: rejectLoser,
    reason: reasonFlag,
  });

  if (!result) {
    console.error(`Could not resolve conflict ${conflictId}. Check the ID and --keep value.`);
    process.exit(1);
  }

  const action = rejectLoser
    ? 'rejected (tombstoned) and removed'
    : forgetLoser
      ? 'deleted'
      : 'weakened (half-life halved)';
  console.log(`Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`);
}

// ---------------------------------------------------------------------------
// AT1: reject / rejections / unreject
// docs/plans/2026-08-15-at1-rejected-value-tombstone.md §4
// ---------------------------------------------------------------------------

function cmdReject(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  // Store resolution mirrors `hippo remember`: --global writes to the
  // global store, otherwise the local store (requireInit'd via resolveAuthRoot).
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantId = resolveTenantId({});

  // --reason is REQUIRED (plan §4, grill issue 4): the tombstone stores no
  // content, so reason is its only human-readable identity.
  const reason = typeof flags['reason'] === 'string' ? (flags['reason'] as string).trim() : '';
  if (!reason) {
    console.error('hippo reject requires --reason "<why>" (the tombstone stores no content; reason is its only identity).');
    process.exit(1);
  }

  const valueFlag = typeof flags['value'] === 'string' ? (flags['value'] as string) : undefined;
  const memoryId = args[0];

  if (!memoryId && valueFlag === undefined) {
    console.error('Usage: hippo reject <memory-id> --reason "<why>"');
    console.error('   or: hippo reject --value "<text>" --reason "<why>"');
    process.exit(1);
  }
  if (memoryId && valueFlag !== undefined) {
    // Ambiguous ask: silently preferring one form would ignore the other
    // without feedback (code-review round-1 low).
    console.error('hippo reject takes EITHER a memory id OR --value, not both.');
    process.exit(1);
  }

  try {
    const result = rejectValue({
      hippoRoot: root,
      tenantId,
      actor: 'cli',
      reason,
      memoryId: valueFlag === undefined ? memoryId : undefined,
      value: valueFlag,
    });
    const digestPrefix = result.digest.slice(0, 12);
    const preview = result.content.length > 80 ? `${result.content.slice(0, 80)}...` : result.content;
    console.log(`Rejected [${digestPrefix}...]: "${preview}"`);
    console.log(`  Reason: ${reason}`);
    if (result.removedIds.length > 0) {
      console.log(`  Removed ${result.removedIds.length} matching row(s): ${result.removedIds.join(', ')}`);
      if (result.successorIds.length > 0) {
        console.log(`  Merged rows that held it keep their other texts in: ${result.successorIds.join(', ')}`);
      }
      if (result.dormantSuccessorIds.length > 0) {
        console.log(`  Dormant merged rows that held it keep their other texts in: ${result.dormantSuccessorIds.join(', ')}`);
      }
    } else {
      console.log('  No live rows matched (pre-emptive tombstone).');
    }
  } catch (err) {
    console.error(`Could not reject: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

function cmdRejections(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantId = resolveTenantId({});
  const rows = listRejectionsForTenant(root, tenantId);

  if (flags['json']) {
    console.log(JSON.stringify({ rejections: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No rejected values.');
    return;
  }

  console.log(`${rows.length} rejected value(s):\n`);
  for (const row of rows) {
    console.log(`--- ${row.digest.slice(0, 12)}...`);
    console.log(`    Reason:       ${row.reason ?? 'none given'}`);
    console.log(`    Rejected by:  ${row.rejectedBy ?? 'unknown'}`);
    console.log(`    Rejected at:  ${row.rejectedAt}`);
    if (row.sourceMemoryId) console.log(`    Source id:    ${row.sourceMemoryId}`);
    if (row.normalizedChars !== null) console.log(`    Chars:        ${row.normalizedChars}`);
    console.log('');
  }
}

function cmdUnreject(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantId = resolveTenantId({});
  const digestOrPrefix = (args[0] ?? '').trim();
  if (!digestOrPrefix) {
    console.error('Usage: hippo unreject <digest-or-prefix>');
    process.exit(1);
  }

  const outcome = unrejectValue(root, tenantId, digestOrPrefix, 'cli');
  if (outcome.status === 'not_found') {
    console.error(`No rejected value matches "${digestOrPrefix}". Run \`hippo rejections\` to list tombstones.`);
    process.exit(1);
  }
  if (outcome.status === 'ambiguous') {
    console.error(`"${digestOrPrefix}" matches ${outcome.candidates.length} tombstones. Use a longer prefix:`);
    for (const c of outcome.candidates) {
      console.error(`  ${c.digest.slice(0, 16)}...  ${c.reason ?? 'none given'}`);
    }
    process.exit(1);
  }

  console.log(`Unrejected [${outcome.digest.slice(0, 12)}...] (was: ${outcome.reason ?? 'none given'})`);
}

/**
 * `hippo dormant [list] [<query>...] [--limit <n>] [--json] [--global]`,
 * `hippo dormant restore <id>`, `hippo dormant forget <id>`.
 * Dormant memories are what sleep keeps instead of deleting (on by default;
 * `"dormant": { "enabled": false }` in .hippo/config.json deletes instead).
 */
function cmdDormant(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const sub = args[0];

  if (sub === 'restore' || sub === 'forget') {
    const id = (args[1] ?? '').trim();
    if (!id) {
      console.error(`Usage: hippo dormant ${sub} <id>`);
      process.exit(1);
    }
    try {
      if (sub === 'restore') {
        api.restoreDormant(ctx, id);
        console.log(`Restored ${id} to active memory.`);
      } else {
        api.forgetDormant(ctx, id);
        console.log(`Forgot dormant memory ${id} permanently.`);
      }
    } catch (err) {
      if (err instanceof RejectedValueError) {
        console.error(`Cannot restore ${id}: its value was rejected (${err.reason ?? 'no reason given'}). Run \`hippo unreject\` first to allow it.`);
      } else {
        console.error(`Could not ${sub} ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
    return;
  }

  const queryArgs = sub === 'list' ? args.slice(1) : args;
  const limit = parseCountFlag(flags['limit']);
  const rows = api.listDormant(ctx, {
    query: queryArgs.join(' '),
    limit: limit > 0 ? limit : undefined,
  });

  if (flags['json']) {
    console.log(JSON.stringify({ dormant: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(queryArgs.length > 0 ? 'No dormant memories match.' : 'No dormant memories.');
    if (!loadConfig(root).dormant.enabled) {
      console.log(`Sleep deletes faded memories. To keep them dormant instead, set "dormant": { "enabled": true } in ${path.join(root, 'config.json')}.`);
    }
    return;
  }

  console.log(`${rows.length} dormant memor${rows.length === 1 ? 'y' : 'ies'}${queryArgs.length > 0 ? ' matching' : ''} (newest first):\n`);
  for (const row of rows) {
    const preview = row.content.length > 100 ? `${row.content.slice(0, 100)}...` : row.content;
    console.log(`--- ${row.id}`);
    console.log(`    ${preview}`);
    console.log(`    Dormant since ${row.dormantAt.slice(0, 10)} (${row.reason}, strength ${row.strength.toFixed(3)})${row.tags.length > 0 ? `  tags: ${row.tags.join(', ')}` : ''}`);
    console.log('');
  }
  console.log('Bring one back: hippo dormant restore <id>   Delete for good: hippo dormant forget <id>');
}

/** `hippo quarantine [list] [--all] [--json] [--global]`, `quarantine approve <id>`, `quarantine reject <id>` (CD5 poisoning defence). */
function cmdQuarantine(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const sub = args[0];

  if (sub === 'approve' || sub === 'reject') {
    const id = (args[1] ?? '').trim();
    if (!id) {
      console.error(`Usage: hippo quarantine ${sub} <id>`);
      process.exit(1);
    }
    try {
      if (sub === 'approve') {
        api.quarantineApprove(ctx, id);
        console.log(`Approved ${id}: restored to its original scope.`);
      } else {
        api.quarantineReject(ctx, id);
        console.log(`Rejected ${id}: stays quarantined.`);
      }
    } catch (err) {
      console.error(`Could not ${sub} ${id}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  const status = flags['all'] ? 'all' : 'pending';
  const rows = api.quarantineList(ctx, { status });

  if (flags['json']) {
    console.log(JSON.stringify({ quarantine: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(status === 'all' ? 'No quarantined memories.' : 'No pending quarantined memories.');
    return;
  }

  console.log(`${rows.length} quarantined memor${rows.length === 1 ? 'y' : 'ies'} (newest first):\n`);
  for (const row of rows) {
    console.log(`--- ${row.id} [${row.status}]`);
    console.log(`    ${row.contentPreview}`);
    console.log(`    ${row.reason}, original scope ${row.originalScope ?? '(none)'}, quarantined ${row.quarantinedAt.slice(0, 10)}`);
    console.log('');
  }
  console.log('Approve: hippo quarantine approve <id>   Reject: hippo quarantine reject <id>');
}

/**
 * `hippo tokens [--days <n>] [--json] [--global]`: the token ledger
 * (ROADMAP TE0). Tokens of memory text handed to agents per surface, blocks
 * the per-prompt hook skipped as unchanged (TE2) and the tokens that saved,
 * and the hook blocks' tokens later model calls re-read, counted when each session ends.
 * Counts are estimates (characters / 4), the same estimate every budget uses.
 */
function cmdTokens(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const days = parseCountFlag(flags['days']);
  const summary = api.tokenSummary(ctx, { days: days > 0 ? days : undefined });
  if (flags['json']) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const windowDays = days > 0 ? days : 30;
  if (summary.surfaces.length === 0) {
    console.log(`No memory text recorded in the last ${windowDays} days.`);
    return;
  }
  console.log(`Memory text handed to agents, last ${windowDays} days (estimated tokens, characters / 4)\n`);
  console.log(
    `  ${'surface'.padEnd(14)}${'sent'.padStart(8)}${'tokens'.padStart(12)}${'skipped'.padStart(10)}${'saved'.padStart(12)}`
    + `${'re-read'.padStart(12)}`,
  );
  for (const row of summary.surfaces) {
    console.log(
      `  ${row.surface.padEnd(14)}${String(row.injected).padStart(8)}${String(row.tokens).padStart(12)}`
      + `${String(row.skipped).padStart(10)}${String(row.tokensAvoided).padStart(12)}${String(row.tokensReread).padStart(12)}`,
    );
  }
  console.log('');
  console.log(`  Total sent: ${summary.totalTokens} tokens. Saved by skipping unchanged blocks: ${summary.totalTokensAvoided}.`);
  console.log(
    `  Re-read by later model calls until compaction: ${summary.totalTokensReread} tokens,`
    + ` counted for ${summary.rereadSessions} of ${summary.hookSessions} sessions.`,
  );
  if (summary.meanTokensPerSession > 0) {
    console.log(`  Mean per session (rows with a session id): ${summary.meanTokensPerSession} tokens.`);
  }
  console.log('  Re-reads are counted for hook and compact-resume blocks when a session ends; other surfaces, and open or crashed sessions, show sent only.');
  console.log("  Re-reads usually bill at the provider's cached-input rate, a fraction of the full input price.");
}

/** `hippo failures [--days <n>] [--json] [--global]`: failed tool calls by outcome, and repeats across sessions (CD13). */
function cmdFailures(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  // The store the capture-error hook writes to; a report never creates one.
  const root = flags['global'] ? getGlobalRoot() : hookStoreRoot(hippoRoot);
  requireInit(root);
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const days = parseCountFlag(flags['days']);
  const summary = api.failureSummary(ctx, { days: days > 0 ? days : undefined });
  if (flags['json']) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const windowDays = days > 0 ? days : 30;
  const kept = windowDays > FAILURE_LOG_RETENTION_DAYS ? ` (rows are kept ${FAILURE_LOG_RETENTION_DAYS} days)` : '';
  if (summary.total === 0) {
    console.log(`No failed tool calls recorded in the last ${windowDays} days${kept}.`);
    return;
  }
  const o = summary.outcomes;
  const errors = o.stored + o.duplicate + o['store-failed'];
  const unsaved = o['store-failed'] > 0 ? `, ${o['store-failed']} could not be saved` : '';
  const rows: ReadonlyArray<readonly [string, number, string]> = [
    ['errors', errors, `(${o.stored} new, ${o.duplicate} already in memory${unsaved})`],
    ['routine', o['skipped-routine'], ''],
    ['interrupted', o['skipped-interrupt'], ''],
    ['unreadable', o['skipped-invalid'], ''],
  ];
  console.log(`Failed tool calls seen by the capture-error hook, last ${windowDays} days${kept}\n`);
  for (const [label, count, note] of rows) {
    console.log(`  ${label.padEnd(13)}${String(count).padStart(6)}  ${note}`.trimEnd());
  }
  // Counts, not a rate: a share means little without a holdout arm to compare against (CD11).
  if (summary.rated > 0) {
    const noSession = errors - summary.rated;
    const unrated = noSession > 0 ? ` ${noSession} more had no session id.` : '';
    console.log(`\n  Repeats: ${summary.repeats} of ${summary.rated} errors first happened in another session.${unrated}`);
  }
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
    const outcomeRaw = String(flags['outcome'] ?? '').trim();
    const summary = String(flags['summary'] ?? '').trim();

    if (!sessionId) {
      console.error('Usage: hippo session complete --session <session-id> --outcome <success|failure|partial> [--summary "..."]');
      process.exit(1);
    }
    if (!isHandoffOutcome(outcomeRaw)) {
      console.error(`Invalid outcome: "${outcomeRaw}". Must be one of: success, failure, partial.`);
      process.exit(1);
    }
    const outcome: HandoffOutcome = outcomeRaw;

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

    const stamped = stampHandoffOutcome(hippoRoot, resolveTenantId({}), sessionId, outcome);
    if (stamped > 0) {
      console.log(`Stamped outcome on handoff for session ${sessionId}`);
    }
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
    if (handoff.outcome) lines.push(`- Outcome: ${handoff.outcome}`);
    if (handoff.targetRuntime) lines.push(`- Target runtime: ${handoff.targetRuntime}`);
    if (handoff.cardId) lines.push(`- Card: ${handoff.cardId}`);
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
    if (handoff.constraints && handoff.constraints.length > 0) {
      lines.push('', '### Constraints');
      for (const constraint of handoff.constraints) {
        lines.push(`- ${constraint}`);
      }
    }
    if (handoff.evidence) {
      lines.push('', '### Evidence', formatHandoffEvidenceLine(handoff.evidence));
    }
    lines.push('');
    console.log(lines.join('\n'));
    return;
  }

  console.error('Usage: hippo session <log|show|latest|resume|complete>');
  process.exit(1);
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
      console.error('Usage: hippo handoff create --summary "..." [--next "..."] [--session <id>] [--task <id>] [--artifact <path>...] [--constraint <text>...] [--outcome <success|failure|partial>] [--target-runtime <name>] [--card-id <id>] [--tests <pass|fail|unknown>]');
      process.exit(1);
    }

    const outcomeRaw = flags['outcome'];
    if (outcomeRaw !== undefined && !isHandoffOutcome(outcomeRaw)) {
      console.error(`Invalid outcome: "${String(outcomeRaw)}". Must be one of: success, failure, partial.`);
      process.exit(1);
    }

    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || `fallback-${Date.now()}-${process.pid}`;
    const nextAction = String(flags['next'] ?? '').trim() || undefined;
    const taskId = String(flags['task'] ?? '').trim() || undefined;
    const artifactFlag = flags['artifact'];
    const artifacts: string[] = Array.isArray(artifactFlag)
      ? artifactFlag
      : (typeof artifactFlag === 'string' ? [artifactFlag] : []);
    const constraintFlag = flags['constraint'];
    const isFlagString = (v: typeof constraintFlag): v is string => typeof v === 'string';
    const constraints: string[] = Array.isArray(constraintFlag)
      ? constraintFlag
      : (isFlagString(constraintFlag) ? [constraintFlag] : []);
    for (const name of ['target-runtime', 'card-id'] as const) {
      // parseArgs turns a value-less flag into `true`; refuse rather than store "true".
      if (flags[name] === true) {
        console.error(`--${name} needs a value`);
        process.exit(1);
      }
    }
    const targetRuntime = String(flags['target-runtime'] ?? '').trim() || undefined;
    const cardId = String(flags['card-id'] ?? '').trim() || undefined;
    const testStatus = String(flags['tests'] ?? '').trim();
    const evidence = collectHandoffEvidence(
      process.cwd(),
      testStatus === 'pass' || testStatus === 'fail' ? testStatus : 'unknown',
    );

    const handoff = saveSessionHandoff(hippoRoot, resolveTenantId({}), {
      version: 1,
      sessionId,
      repoRoot: process.cwd(),
      taskId,
      summary,
      nextAction,
      artifacts,
      constraints,
      evidence,
      // SAFETY: isHandoffOutcome above already refused any non-matching value.
      outcome: outcomeRaw as HandoffOutcome | undefined,
      targetRuntime,
      cardId,
    });

    console.log(`Created session handoff for session ${handoff.sessionId}`);
    console.log(`   Summary: ${handoff.summary}`);
    if (handoff.nextAction) console.log(`   Next: ${handoff.nextAction}`);
    if (handoff.artifacts && handoff.artifacts.length > 0) {
      console.log(`   Artifacts: ${handoff.artifacts.join(', ')}`);
    }
    if (handoff.constraints && handoff.constraints.length > 0) {
      console.log(`   Constraints: ${handoff.constraints.join(', ')}`);
    }
    if (handoff.outcome) console.log(`   Outcome: ${handoff.outcome}`);
    if (handoff.targetRuntime) console.log(`   Target runtime: ${handoff.targetRuntime}`);
    if (handoff.cardId) console.log(`   Card: ${handoff.cardId}`);
    if (handoff.evidence) console.log(`   Evidence: ${formatHandoffEvidenceLine(handoff.evidence)}`);
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

// Mirrors ARCHIVE_REASON_REQUIRED so the block message can't drift from its usage line.
const CARD_BLOCK_REASON_REQUIRED = 'hippo card block <id> requires --reason "<why>" (recorded as a comment).';

function printCard(detail: CardDetail): void {
  const { card, deps, runs, comments, handoff } = detail;
  console.log(`## Card ${card.id}\n`);
  console.log(`- Title: ${card.title}`);
  console.log(`- Status: ${card.status}`);
  if (card.assigneeRuntime) console.log(`- Assignee: ${card.assigneeRuntime}`);
  if (card.leaseUntil) console.log(`- Lease until: ${card.leaseUntil}`);
  if (card.heartbeatAt) console.log(`- Heartbeat: ${card.heartbeatAt}`);
  if (card.repo) console.log(`- Repo: ${card.repo}`);
  if (card.contract) console.log(`- Contract: ${card.contract}`);
  if (card.budget !== null) console.log(`- Budget: ${card.budget}`);
  console.log(`- Updated: ${card.updatedAt}`);

  if (deps.parents.length > 0) console.log(`- Parents: ${deps.parents.join(', ')}`);
  if (deps.children.length > 0) console.log(`- Children: ${deps.children.join(', ')}`);

  if (runs.length > 0) {
    console.log('\n### Runs');
    for (const run of runs) {
      console.log(`- run ${run.id}: ${run.runtime} started ${run.started}${run.ended ? ` ended ${run.ended} (${run.outcome})` : ' (open)'}`);
    }
  }

  if (comments.length > 0) {
    console.log('\n### Comments');
    for (const comment of comments) {
      console.log(`- [${comment.createdAt}] ${comment.author}: ${comment.body}`);
    }
  }

  if (handoff) {
    console.log('\n### Latest handoff');
    console.log(`- Session: ${handoff.sessionId}, updated ${handoff.updatedAt}`);
    console.log(handoff.summary);
  }
  console.log('');
}

// A too-large --run would silently round to a different id (mirrors parsePositiveIncidentId).
function cardRunFlag(flags: Record<string, string | boolean | string[]>): number | undefined {
  const raw = cardStringFlag(flags, 'run');
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n <= 0) {
    console.error(`Invalid --run: "${raw}" (expected a positive integer).`);
    process.exit(1);
  }
  return n;
}

// Reads after the store already refused, so this only explains the refusal, never changes it.
function cardRefusal(hippoRoot: string, tenantId: string, id: string): string {
  const card = loadCard(hippoRoot, tenantId, id);
  const liveRun = loadCardRuns(hippoRoot, tenantId, id).find((r) => !r.ended);
  return `status ${card?.status ?? 'unknown'}, live run ${liveRun?.id ?? 'none'}`;
}

// One entry per subcommand: the flags cmdCard actually reads for it, so a typo like
// --depend-on fails fast instead of silently doing nothing.
type CardSubcommand = 'create' | 'show' | 'list' | 'claim' | 'heartbeat' | 'block' | 'review' | 'complete' | 'reclaim' | 'comment';
const CARD_SUBCOMMAND_FLAGS = {
  create: ['title', 'repo', 'contract', 'budget', 'depends-on'],
  show: ['json'],
  list: ['status', 'json'],
  claim: ['runtime', 'session'],
  heartbeat: ['run'],
  block: ['reason', 'run'],
  review: ['run'],
  complete: ['outcome', 'run'],
  reclaim: new Array<string>(),
  comment: ['body', 'author'],
} satisfies Record<CardSubcommand, string[]>;

function cmdCard(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);
  const tenantId = resolveTenantId({});
  const subcommand = args[0] ?? '';

  if (Object.hasOwn(CARD_SUBCOMMAND_FLAGS, subcommand)) {
    // SAFETY: hasOwn, unlike `in`, skips inherited keys such as constructor, so subcommand is a real key.
    const allowedFlags = CARD_SUBCOMMAND_FLAGS[subcommand as CardSubcommand];
    for (const key of Object.keys(flags)) {
      if (!allowedFlags.includes(key)) {
        const valid = allowedFlags.length > 0 ? allowedFlags.map((f) => `--${f}`).join(', ') : '(none)';
        console.error(`Unknown flag --${key} for hippo card ${subcommand}. Valid flags: ${valid}`);
        process.exit(1);
      }
    }
  }

  if (subcommand === 'create') {
    const title = cardStringFlag(flags, 'title') ?? '';
    if (!title) {
      console.error('Usage: hippo card create --title "..." [--repo <name>] [--contract <text>] [--budget <n>] [--depends-on <id>...]');
      process.exit(1);
    }
    const repo = cardStringFlag(flags, 'repo') || undefined;
    const contract = cardStringFlag(flags, 'contract') || undefined;
    const budgetRaw = cardStringFlag(flags, 'budget');
    let budget: number | undefined;
    if (budgetRaw !== undefined) {
      if (!/^\d+$/.test(budgetRaw)) {
        console.error(`Invalid budget: "${budgetRaw}" (expected a positive integer)`);
        process.exit(1);
      }
      budget = Number(budgetRaw);
    }
    const dependsOnFlag = flags['depends-on'];
    if (dependsOnFlag === true) {
      console.error('--depends-on requires a value');
      process.exit(1);
    }
    const dependsOn: string[] = Array.isArray(dependsOnFlag) ? dependsOnFlag : [];

    let card: Card;
    try {
      card = createCard(hippoRoot, tenantId, { title, repo, contract, budget, dependsOn });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    console.log(`Created card ${card.id} (status: ${card.status})`);
    return;
  }

  if (subcommand === 'show') {
    const id = args[1];
    if (!id) {
      console.error('Usage: hippo card show <id> [--json]');
      process.exit(1);
    }
    const detail = loadCardDetail(hippoRoot, tenantId, id);
    if (!detail) {
      console.error(`No card found with id ${id}.`);
      process.exit(1);
    }
    if (flags['json']) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    printCard(detail);
    return;
  }

  if (subcommand === 'list') {
    const status = cardStringFlag(flags, 'status');
    if (status !== undefined && !isCardStatus(status)) {
      console.error(`Invalid status: "${status}".`);
      process.exit(1);
    }
    const cards = listCards(hippoRoot, tenantId, { status });
    if (flags['json']) {
      console.log(JSON.stringify({ cards }, null, 2));
      return;
    }
    if (cards.length === 0) {
      console.log('No cards found.');
      return;
    }
    for (const card of cards) {
      console.log(`${card.id}\t${card.status}\t${card.title}${card.assigneeRuntime ? `\t(${card.assigneeRuntime})` : ''}`);
    }
    return;
  }

  if (subcommand === 'claim') {
    const id = args[1];
    const runtime = cardStringFlag(flags, 'runtime') ?? '';
    if (!id || !runtime) {
      console.error('Usage: hippo card claim <id> --runtime <name> [--session <id>]');
      process.exit(1);
    }
    const sessionId = cardStringFlag(flags, 'session') || undefined;
    let card: (Card & { runId: number }) | null;
    try {
      card = claimCard(hippoRoot, tenantId, id, runtime, sessionId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!card) {
      console.error(`Could not claim card ${id} (not ready/blocked, or already claimed).`);
      process.exit(1);
    }
    console.log(`Claimed card ${card.id} for ${runtime} (run ${card.runId}, lease until ${card.leaseUntil})`);
    return;
  }

  if (subcommand === 'heartbeat') {
    const id = args[1];
    const runId = cardRunFlag(flags);
    if (!id || runId === undefined) {
      console.error('Usage: hippo card heartbeat <id> --run <n>');
      process.exit(1);
    }
    let card: Card | null;
    try {
      card = heartbeatCard(hippoRoot, tenantId, id, runId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!card) {
      console.error(`Could not heartbeat card ${id} (${cardRefusal(hippoRoot, tenantId, id)}).`);
      process.exit(1);
    }
    console.log(`Heartbeat card ${card.id}: lease until ${card.leaseUntil}`);
    return;
  }

  if (subcommand === 'block') {
    const id = args[1];
    const reason = cardStringFlag(flags, 'reason') ?? '';
    if (!id || !reason) {
      console.error(CARD_BLOCK_REASON_REQUIRED);
      process.exit(1);
    }
    const runId = cardRunFlag(flags);
    let card: Card | null;
    try {
      card = blockCard(hippoRoot, tenantId, id, reason, runId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!card) {
      const why = runId === undefined ? 'not running' : cardRefusal(hippoRoot, tenantId, id);
      console.error(`Could not block card ${id} (${why}).`);
      process.exit(1);
    }
    console.log(`Blocked card ${card.id}`);
    return;
  }

  if (subcommand === 'review') {
    const id = args[1];
    if (!id) {
      console.error('Usage: hippo card review <id> [--run <n>]');
      process.exit(1);
    }
    const runId = cardRunFlag(flags);
    let card: Card | null;
    try {
      card = reviewCard(hippoRoot, tenantId, id, runId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!card) {
      const why = runId === undefined ? 'not running' : cardRefusal(hippoRoot, tenantId, id);
      console.error(`Could not move card ${id} to review (${why}).`);
      process.exit(1);
    }
    console.log(`Card ${card.id} moved to review`);
    return;
  }

  if (subcommand === 'complete') {
    const id = args[1];
    const outcomeRaw = flags['outcome'];
    if (!id || !isHandoffOutcome(outcomeRaw)) {
      console.error('Usage: hippo card complete <id> --outcome <success|failure|partial> [--run <n>]');
      process.exit(1);
    }
    const runId = cardRunFlag(flags);
    let result: { card: Card; promotedChildren: string[] } | null;
    try {
      result = completeCard(hippoRoot, tenantId, id, outcomeRaw, runId);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (!result) {
      const why = runId === undefined ? 'not in review' : cardRefusal(hippoRoot, tenantId, id);
      console.error(`Could not complete card ${id} (${why}).`);
      process.exit(1);
    }
    console.log(`Completed card ${result.card.id} (status: ${result.card.status})`);
    if (result.promotedChildren.length > 0) {
      console.log(`Promoted to ready: ${result.promotedChildren.join(', ')}`);
    }
    return;
  }

  if (subcommand === 'reclaim') {
    if (args.length > 1) {
      console.error('Usage: hippo card reclaim (sweeps every expired lease; use hippo card block <id> for one card)');
      process.exit(1);
    }
    const ids = reclaimExpiredCards(hippoRoot, tenantId);
    if (ids.length === 0) {
      console.log('No expired leases.');
      return;
    }
    for (const id of ids) {
      console.log(`Reclaimed card ${id} (now ready)`);
    }
    return;
  }

  if (subcommand === 'comment') {
    const id = args[1];
    if (!id) {
      console.error('Usage: hippo card comment <id> --body "..." [--author <name>]');
      process.exit(1);
    }
    // Only show and comment look the card up directly; claim/heartbeat/block/review/complete throw from the store instead.
    const card = loadCard(hippoRoot, tenantId, id);
    if (!card) {
      console.error(`No card found with id ${id}.`);
      process.exit(1);
    }
    const body = cardStringFlag(flags, 'body') ?? '';
    if (!body) {
      console.error('Usage: hippo card comment <id> --body "..." [--author <name>]');
      process.exit(1);
    }
    const author = cardStringFlag(flags, 'author') || 'cli';
    const comment = addCardComment(hippoRoot, tenantId, id, author, body);
    console.log(`Added comment ${comment.id} to card ${id}`);
    return;
  }

  console.error('Usage: hippo card <create|show|list|claim|heartbeat|block|review|complete|reclaim|comment>');
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
        const child = spawn(cmd, cmdArgs as string[], { detached: true, stdio: 'ignore', windowsHide: true });
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

/** Hook commands share one handle per store and wait at most HOOK_DB_WAIT_MS for a lock; a store still busy after that skips the hook's work with one warning, exit 0. */
async function runHookWithStores<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await withSharedStoreHandles(fn, { busyWaitMs: HOOK_DB_WAIT_MS });
  } catch (error) {
    if (!isSqliteBusy(error)) throw error;
    noteStoreBusy('hook skipped');
    return undefined;
  }
}

async function cmdContext(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  stdinText?: string
): Promise<void> {
  const rec = startDeliveryRecorder(hippoRoot, flags, stdinText);
  // No try/finally: a render throw keeps its own exit code and writes no event.
  await renderContext(hippoRoot, args, flags, stdinText, rec);
  flushDeliveryRecorder(rec);
}

/** A delivery recorder for a pinned-only call when its ledger store enables one, else null; never throws. */
function startDeliveryRecorder(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
  stdinText: string | undefined,
): DeliveryRecorder | null {
  if (flags['pinned-only'] !== true) return null;
  try {
    // The same store withLedgerDb writes the token ledger to, so its config governs both.
    const root = isInitialized(hippoRoot) ? hippoRoot : isInitialized(getGlobalRoot()) ? getGlobalRoot() : null;
    if (root === null || !loadConfig(root).deliveryLedger.enabled) return null;
    return createDeliveryRecorder({
      root,
      storeHash: blockHash(path.resolve(root)),
      writeStore: isGlobalStoreRoot(root) ? 'global' : 'local',
      tenantId: resolveTenantId({}),
      stdinText,
      envSessionId: hostSessionId(),
    });
  } catch (error) {
    console.error(`[hippo] delivery ledger skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** With `db`, writes on the token ledger's handle (same store); without it, opens its own. A second flush is a no-op. */
function flushDeliveryRecorder(rec: DeliveryRecorder | null, db?: ReturnType<typeof openHippoDb>): void {
  if (rec === null) return;
  try {
    rec.flush((input) => (db ? writeDeliveryEventOnHandle(db, input) : writeDeliveryEventAtRoot(rec.root, input)));
  } catch (error) {
    console.error(`[hippo] delivery ledger write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Whether this session sits in the pilot's holdout arm (src/pilot-arm.ts). Off at rate 0 and with no session id.
 * `write` books the arm row; a read-only caller (env-only id, sub-agent) follows the stored arm, else the hash.
 */
function inPilotHoldout(hippoRoot: string, tenantId: string, sessionId: string | undefined, write: boolean): boolean {
  if (sessionId === undefined) return false;
  const root = isInitialized(hippoRoot) ? hippoRoot : isInitialized(getGlobalRoot()) ? getGlobalRoot() : null;
  if (root === null) return false;
  const rate = loadConfig(root).pilot.holdoutRateBp;
  if (rate <= 0) return false;
  const arm = withLedgerDb(hippoRoot, (db) =>
    write ? ensurePilotArm(db, tenantId, sessionId, rate) : readPilotArm(db, sessionId) ?? hashArm(sessionId, rate), ARM_LOCK_WAIT_MS);
  return (arm ?? hashArm(sessionId, rate)) === 'holdout';
}

async function renderContext(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  stdinText: string | undefined,
  rec: DeliveryRecorder | null,
): Promise<void> {
  // --pinned-only fires on every UserPromptSubmit — including in directories
  // that don't have a local .hippo. Skip requireInit for that path and fall
  // back to global-only inside api.getContext. The non-pinned path still
  // requires init (handled by CLI for user-friendly error messaging).
  const pinnedOnly = flags['pinned-only'] === true;
  if (!pinnedOnly) {
    requireInit(hippoRoot);
  }

  // DF1 T2: resolve the calling session's id for the bounded active-task-
  // snapshot read (api.getContext -> loadFreshActiveTaskSnapshot). Stdin
  // payload (the UserPromptSubmit hook JSON) wins; falls back to
  // hostSessionId(); absent both, undefined -- api.getContext then applies
  // the pure freshness bound with no owner-match short-circuit.
  let payloadSessionId: string | undefined;
  // Z1: the hook payload's raw prompt, read beside session_id (docs/plans/2026-09-26-z1-prompt-recall.md).
  let payloadPrompt: string | undefined;
  if (stdinText && stdinText.trim() !== '') {
    try {
      // SAFETY: both fields are type-checked below before use; `?? {}` covers a JSON null payload.
      const { session_id: sid, prompt } = (JSON.parse(stdinText.trim()) ?? {}) as { session_id?: unknown; prompt?: unknown };
      if (typeof sid === 'string' && sid.trim() !== '') payloadSessionId = sid;
      if (typeof prompt === 'string') payloadPrompt = prompt;
    } catch {
      // Malformed/non-JSON stdin: fall through to the env fallback below.
    }
  }
  const currentSessionId = payloadSessionId ?? hostSessionId();
  // A sub-agent's payload and env both carry its parent's session id, so it books no session and never skips a block.
  const subagent = isSubagentPayload(stdinText);
  const ledgerSessionId = subagent ? undefined : currentSessionId;
  if (subagent) payloadSessionId = undefined;

  // The pilot arm is booked at the first hook call whatever the flags, so the holdout sees no budget or content branch.
  const resolvedTenant = resolveTenantId({});
  if (inPilotHoldout(hippoRoot, resolvedTenant, currentSessionId, payloadSessionId !== undefined)) {
    rec?.disabled();
    return;
  }

  const budget = parseBudgetFlag(flags['budget'], 1500);
  if (budget <= 0) {
    rec?.disabled();
    return;
  }

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
    tenantId: resolvedTenant,
    actor: api.adminActor('cli'),
  };
  // v39 memory scope isolation: --cross-project re-includes other-project
  // memories (rendered under a demarcated section below).
  const crossProject = flags['cross-project'] === true;

  const format = String(flags['format'] ?? 'markdown');
  const framing = String(flags['framing'] ?? 'observe');

  const opts: api.ContextOpts = {
    q: query,
    budget,
    limit: parseLimitFlag(flags['limit']),
    pinnedOnly,
    scope: ctxActiveScope ?? undefined,
    includeRecent: parseCountFlag(flags['include-recent']),
    crossProject,
    currentSessionId,
    prompt: payloadPrompt,
    // JSON is budgeted as the markdown it stands for, so one budget picks the same memories in every format.
    cost: contextCost(format === 'additional-context' ? 'additional-context' : 'markdown', framing),
    deliveryObserver: rec ?? undefined,
  };

  const result = await api.getContext(ctx, opts);

  // Early exit when there's nothing to render (matches pre-extraction behavior).
  const hasContextData =
    result.entries.length > 0 ||
    result.activeSnapshot ||
    result.sessionHandoff ||
    (result.recentEvents && result.recentEvents.length > 0);
  if (!hasContextData) {
    rec?.delivered({ state: 'empty' });
    return;
  }

  // Adapter: ContextResultEntry -> the print-helper input shape. v39:
  // cross-project inclusions (only present under --cross-project or with
  // isolation disabled via crossProject) render in their own demarcated
  // section so they can never masquerade as project memory.
  const mainEntries = result.entries.filter((r) => r.category !== 'cross-project');
  const crossEntries = result.entries.filter((r) => r.category === 'cross-project');
  const renderItems = mainEntries.map((r) => ({
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
      origin: r.origin ?? null,
      category: r.category ?? null,
    }));
    const jsonText = JSON.stringify({
      query: query || '*',
      activeSnapshot: result.activeSnapshot ?? null,
      sessionHandoff: result.sessionHandoff ?? null,
      recentSessionEvents: result.recentEvents ?? [],
      memories: output,
      tokens: result.tokens,
    });
    console.log(jsonText);
    rec?.delivered({ state: 'sent', emittedText: `${jsonText}\n` });
    withLedgerDb(hippoRoot, (db) => {
      recordTokenUse(db, {
        tenantId: ctx.tenantId, sessionId: ledgerSessionId, surface: pinnedOnly ? 'hook' : 'context',
        event: 'inject', items: output.length, tokens: estimateTokens(jsonText),
      });
      flushDeliveryRecorder(rec, db);
    });
  } else if (format === 'additional-context') {
    // Z1: split into a static block (snapshot/handoff/events/pins/recent-N,
    // TE2-skippable) and a prompt-recall block (never skipped, own heading).
    const staticEntries = mainEntries.filter((r) => !r.promptRecall);
    const staticCrossEntries = crossEntries.filter((r) => !r.promptRecall);
    const recallEntries = result.entries.filter((r) => r.promptRecall);
    const staticItems = staticEntries.map((r) => ({ entry: r.entry, score: r.score, tokens: r.tokens, isGlobal: r.isGlobal ?? false }));
    const recallItems = recallEntries.map((r) => ({ entry: r.entry, score: r.score, tokens: r.tokens, isGlobal: r.isGlobal ?? false }));

    const staticBlock = settleTokens((t) => captureConsole(() => {
      if (result.activeSnapshot) printActiveTaskSnapshot(result.activeSnapshot);
      if (result.sessionHandoff) printHandoff(result.sessionHandoff);
      if (result.recentEvents && result.recentEvents.length > 0) {
        printSessionEvents(result.recentEvents);
      }
      // TE1: no live strength percentage, so an unchanged set of memories renders byte-identically turn after turn.
      if (staticItems.length > 0) printContextMarkdown(staticItems, t, framing, { showStrength: false });
      printCrossProjectSection(staticCrossEntries);
    }));
    const recallBlock = recallItems.length > 0
      ? settleTokens((t) => captureConsole(() => printContextMarkdown(recallItems, t, framing, { showStrength: false, heading: 'Prompt-Relevant Memory' })))
      : '';
    if (!staticBlock.trim() && !recallBlock.trim()) {
      rec?.delivered({ state: 'empty' });
      return;
    }

    const surface: TokenSurface = pinnedOnly ? 'hook' : 'context';
    let sendStatic = staticBlock.trim().length > 0;
    // TE2: the per-prompt hook skips a static block identical to the one this
    // session already has, resent every refreshTurns skips. Hashed on the
    // static text alone so an unchanged pin set still skips while recall varies.
    if (sendStatic && pinnedOnly && payloadSessionId !== undefined) {
      const injectCfg = loadConfig(hippoRoot).pinnedInject;
      if (injectCfg.skipUnchanged !== false) {
        const refreshTurns = Number.isFinite(injectCfg.refreshTurns) && injectCfg.refreshTurns >= 0
          ? injectCfg.refreshTurns
          : 10;
        const staticHash = blockHash(staticBlock);
        const last = withLedgerDb(hippoRoot, (db) =>
          lastSentState(db, ctx.tenantId, payloadSessionId, surface));
        if (shouldSkipUnchanged(last ?? null, staticHash, refreshTurns)) {
          withLedgerDb(hippoRoot, (db) => {
            recordTokenUse(db, {
              tenantId: ctx.tenantId, sessionId: payloadSessionId, surface, event: 'skip',
              items: staticItems.length, tokens: estimateTokens(staticBlock), hash: staticHash,
            });
            if (recallBlock.trim()) return;
            rec?.delivered({ state: 'reused', staticHash, staticReused: true });
            flushDeliveryRecorder(rec, db);
          });
          sendStatic = false;
        }
      }
    }

    const finalStatic = sendStatic ? staticBlock : '';
    const additionalContext = finalStatic && recallBlock
      ? `${finalStatic}\n\n${recallBlock}`
      : finalStatic || recallBlock;
    const staticReused = !sendStatic && staticBlock.trim().length > 0;
    if (!additionalContext.trim()) {
      rec?.delivered({ state: 'reused', staticHash: blockHash(staticBlock), staticReused });
      return;
    }

    const payload = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    };
    process.stdout.write(JSON.stringify(payload));
    rec?.delivered({
      state: staticReused ? 'reused-recall-sent' : 'sent',
      staticHash: staticBlock.trim() ? blockHash(staticBlock) : null,
      recallHash: recallBlock ? blockHash(recallBlock) : null,
      emittedText: additionalContext,
      staticReused,
    });
    if (finalStatic || recallBlock) {
      // One connection for both rows; each insert in its own try so one failing doesn't skip the other.
      withLedgerDb(hippoRoot, (db) => {
        if (finalStatic) {
          try {
            recordTokenUse(db, {
              tenantId: ctx.tenantId, sessionId: ledgerSessionId, surface, event: 'inject',
              items: staticItems.length, tokens: estimateTokens(finalStatic), hash: blockHash(finalStatic),
            });
          } catch (error) { if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped'); }
        }
        if (recallBlock) {
          try {
            recordTokenUse(db, {
              tenantId: ctx.tenantId, sessionId: ledgerSessionId, surface: 'hook_recall', event: 'inject',
              items: recallItems.length, tokens: estimateTokens(recallBlock), hash: blockHash(recallBlock),
            });
          } catch (error) { if (isSqliteBusy(error)) noteStoreBusy('token ledger row skipped'); }
        }
        flushDeliveryRecorder(rec, db);
      });
    }
  } else {
    // markdown (default); the header figure counts the whole block, sections included, as the ledger does.
    const text = settleTokens((t) => captureConsole(() => {
      if (result.activeSnapshot) {
        printActiveTaskSnapshot(result.activeSnapshot);
      }
      if (result.sessionHandoff) {
        printHandoff(result.sessionHandoff);
      }
      if (result.recentEvents && result.recentEvents.length > 0) {
        printSessionEvents(result.recentEvents);
      }
      if (renderItems.length > 0) printContextMarkdown(renderItems, t, framing);
      printCrossProjectSection(crossEntries);
      if (result.ambientState) {
        console.log(`\n${renderAmbientSummary(result.ambientState)}`);
      }
    }));
    if (text.length > 0) console.log(text);
    rec?.delivered(text.length > 0 ? { state: 'sent', emittedText: `${text}\n` } : { state: 'empty' });
    withLedgerDb(hippoRoot, (db) => {
      recordTokenUse(db, {
        tenantId: ctx.tenantId, sessionId: ledgerSessionId, surface: pinnedOnly ? 'hook' : 'context',
        event: 'inject', items: renderItems.length, tokens: estimateTokens(text),
      });
      flushDeliveryRecorder(rec, db);
    });
  }
}

/**
 * v39: render cross-project inclusions under an explicit header so agents
 * (and humans) can tell borrowed context from project memory. Only ever
 * non-empty when the caller passed --cross-project or disabled isolation.
 */
function printCrossProjectSection(items: api.ContextResultEntry[]): void {
  if (items.length === 0) return;
  console.log(crossProjectHeading(items.length));
  for (const item of items) console.log(crossProjectLine(item));
}

/** @internal — exported for snapshot tests (tests/cli-context-render-snapshot.test.ts). NOT a stable public API. */
export function printContextMarkdown(
  items: Array<{ entry: MemoryEntry; score: number; tokens: number; isGlobal: boolean }>,
  totalTokens: number,
  framing: string = 'observe',
  opts: { showStrength?: boolean; heading?: string } = {}
): void {
  const now = evalNow();
  const showStrength = opts.showStrength !== false;
  console.log(contextHeading(opts.heading ?? 'Project Memory', items.length, totalTokens));
  for (const item of items) console.log(contextLine(item, framing, showStrength, now));
}

// ---------------------------------------------------------------------------
// Embed command
// ---------------------------------------------------------------------------

async function cmdEmbed(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>
): Promise<void> {
  // --global mirrors resolveAuthRoot (cli.ts:6900): initGlobal() + the global
  // root, skipping the local requireInit entirely, so this is the healing
  // path for pre-1.27.0 global stores from a directory with no local .hippo.
  const root = resolveAuthRoot(hippoRoot, flags);

  // --status and --reset-physics only read cached state, so they must work even
  // when no provider key is present (e.g. embedded earlier with a key that was
  // later removed). The provider-availability gate is deferred to the embed path.
  if (flags['reset-physics']) {
    const entries = loadAllEntries(root);
    const embIndex = loadEmbeddingIndex(root);
    const db = openHippoDb(root);
    try {
      const count = resetAllPhysicsState(db, entries, embIndex);
      console.log(`Reset physics state: ${count} particles re-initialized from embeddings.`);
    } finally {
      closeHippoDb(db);
    }
    return;
  }

  if (flags['status']) {
    const entries = loadAllEntries(root);
    const embIndex = loadEmbeddingIndex(root);
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
      return resolveEmbeddingProvider(root);
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
    if (loadConfig(root).embeddings.enabled === false) {
      console.log('Embeddings are disabled in config (embeddings.enabled = false). Set it to true or "auto" to enable.');
      return;
    }
    if (embedProvider.kind === 'local') {
      console.log('Embeddings not available. Install @huggingface/transformers to enable:');
      console.log('  npm install @huggingface/transformers');
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
    count = await embedAll(root, resolveEmbeddingModel(root));
  } catch (err) {
    console.error(`Embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    const partial = loadEmbeddingIndex(root);
    console.error(
      `Partial progress saved: ${Object.keys(partial).length} embeddings on disk. Re-run \`hippo embed\` to resume.`,
    );
    process.exitCode = 1;
    return;
  }
  const entriesAfter = loadAllEntries(root);
  const embIndexAfter = loadEmbeddingIndex(root);
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

  const entry = captureError(exitCode, stderr, command, resolveTenantId({}));
  // Compute schema fit against existing memories
  const existingWatch = loadAllEntries(hippoRoot, entry.tenantId);
  const watchFit = computeSchemaFit(entry.content, entry.tags, existingWatch);
  entry.schema_fit = watchFit;
  entry.half_life_days = deriveHalfLife(loadConfig(hippoRoot).defaultHalfLifeDays, entry);
  entry.strength = calculateStrength(entry);
  // AT1 (plan §3 containment): mechanical content from a failed command — a
  // rejection-guard refusal here must not crash the watcher. Skip silently
  // (loud enough via the message below) and still exit with the wrapped
  // command's real exit code.
  try {
    writeEntry(hippoRoot, entry);
    updateStats(hippoRoot, { remembered: 1 });
    void embedMemory(hippoRoot, entry);

    const preview = stderr.trim().slice(0, 80);
    console.error(`\nHippo learned from failure: "${preview}"`);
  } catch (err) {
    if (err instanceof RejectedValueError) {
      console.error(`\nHippo: this failure matches a rejected value (${err.reason ?? 'no reason given'}); not stored.`);
    } else {
      throw err;
    }
  }

  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Learn command
// ---------------------------------------------------------------------------

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

function warnRedacted(count: number | undefined): void {
  if (count) console.error(`Warning: secret-shaped text was redacted from ${count} imported ${count === 1 ? 'entry' : 'entries'} before storing`);
}

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

  if (flags['agents']) {
    const opts = { machine: currentMachine(), dryRun };
    // A folder without a store of its own imports as session end would there, so its notes are not hidden.
    const report = useGlobal || isInitialized(hippoRoot)
      ? importForStore(useGlobal ? getGlobalRoot() : hippoRoot, opts)
      : importAtSessionEnd(process.cwd(), undefined, opts);
    for (const line of detailLines(report, dryRun)) console.log(line);
    for (const warning of report.warnings) console.error(`hippo: agent memories: ${warning}`);
    return;
  }

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
    if (typeof flags['name'] !== 'string' || !flags['name'].trim()) {
      // --name is the vault identity key for the destructive source-deletion sync;
      // inferring it from the folder basename let same-basename vaults collide and
      // clobber each other (codex R10 P2). A valueless `--name` parses as boolean
      // true, and String(true) === "true" would silently import under vault:true:*
      // - reject a non-string so it fails fast instead (codex R11 P2).
      console.error('hippo import --vault requires --name <vault> (a non-empty identity key for source-deletion sync).');
      process.exit(1);
    }
    if (flags['scope'] !== undefined && (typeof flags['scope'] !== 'string' || !flags['scope'].trim())) {
      // Same valueless-flag trap: a bare `--scope` must not become scope "true".
      // Example uses the source-prefixed private form, since a bare `private` scope
      // is NOT treated as private by recall and importVault rejects it (R13 P2).
      console.error('hippo import --vault: --scope requires a value (e.g. --scope vault:private:notes).');
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
    if ((vaultResult.rejected ?? 0) > 0) {
      console.log(`  Rejected (tombstoned): ${vaultResult.rejected}`);
    }
    warnRedacted(vaultResult.redacted);
    console.log(`  ${dryRun ? 'Would archive:        ' : 'Archived (removed):   '}${vaultResult.archived ?? 0}`);
    console.log(`  Store:                 ${hippoRoot}`);
    // Batch producer, same contract as the single-file import below: vault rows
    // write through api.remember (which never embeds), so backfill them here.
    // Floating promise is deliberate; see the comment at the single-file site.
    if (!dryRun && vaultResult.imported >= 1) {
      void embedAll(hippoRoot).catch(() => {});
    }
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
    console.error('Usage: hippo import <--chatgpt|--claude|--cursor|--file|--markdown|--vault> <path>, or hippo import --agents [--dry-run]');
    process.exit(1);
  }

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const result = importer(filePath, importOptions);

  // Batch producer: embed newly-imported rows on targetRoot in one pass
  // rather than per-row (importers.ts writeEntry sites don't embed). The
  // floating promise is deliberate: libuv keeps the process alive until it
  // settles, so it is not dropped on process exit; `hippo embed --global` (or
  // a local `hippo embed`) is the backstop if it does get interrupted. Do not
  // "fix" this by awaiting it, that would block the CLI on model load/backfill.
  if (!dryRun && result.imported >= 1) {
    void embedAll(targetRoot).catch(() => {});
  }

  const storeLabel = useGlobal ? `global (${getGlobalRoot()})` : targetRoot;

  console.log(`\nImport ${importerName}: ${filePath}`);
  console.log(`  Source entries found:  ${result.total}`);
  console.log(`  Imported:              ${result.imported}`);
  console.log(`  Skipped (dedup/noise): ${result.skipped}`);
  if ((result.rejected ?? 0) > 0) {
    console.log(`  Rejected (tombstoned): ${result.rejected}`);
  }
  warnRedacted(result.redacted);
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

function cmdSync(hippoRoot: string, flags: Record<string, string | boolean | string[]> = {}): void {
  requireInit(hippoRoot);

  const globalRoot = getGlobalRoot();
  if (!isInitialized(globalRoot)) {
    console.log('No global store found. Run `hippo init --global` first.');
    return;
  }

  // v39: other-project rows are skipped by default; secrets always are.
  const includeCrossProject = flags['cross-project'] === true;
  const count = syncGlobalToLocal(hippoRoot, globalRoot, { includeCrossProject });
  console.log(`Synced ${count} global memories into local project.${includeCrossProject ? '' : ' (other-project rows skipped; use --cross-project to include them)'}`);
}

// ---------------------------------------------------------------------------
// Hook install/uninstall
// ---------------------------------------------------------------------------

function cmdHook(
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  const subcommand = args[0];
  const target = args[1];
  // Cursor has no init row, so the AGENTS.md block is usually another agent's, and Cursor reads that one as it is.
  const othersBlock = (text: string) => target === 'cursor' && hippoBlock(text)?.owner !== 'cursor';

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

      if (existing.includes(HOOK_MARKERS.start) && othersBlock(existing)) {
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
      if (existing.includes(HOOK_MARKERS.start) && othersBlock(existing)) {
        const owner = hippoBlock(existing)?.owner;
        const whose = owner ? `hippo wrote it for ${owner}` : 'it has been edited, so hippo cannot tell whose it is';
        console.log(`Left the hippo block in ${hook.file}: ${whose}. Delete it by hand if no agent needs it.`);
      } else if (existing.includes(HOOK_MARKERS.start)) {
        fs.writeFileSync(filepath, withoutHookBlock(existing) + '\n', 'utf8');
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
      if (uninstallJsonHooks('codex')) {
        console.log(`Removed hippo's Codex memory hooks from ${resolveJsonHookPaths('codex').settings}`);
      }
      if (uninstallCodexWrapper()) {
        console.log('Removed Codex wrapper integration');
      }
    } else if (target === 'cursor') {
      // Older hippo wrote Cursor's block to .cursorrules, creating the file when it was missing.
      const legacy = path.resolve(process.cwd(), '.cursorrules');
      const old = fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8') : '';
      if (old.includes(HOOK_MARKERS.start)) {
        const left = withoutHookBlock(old);
        if (left) fs.writeFileSync(legacy, left + '\n', 'utf8');
        else fs.unlinkSync(legacy);
        console.log(left ? 'Removed the old Hippo hook from .cursorrules' : 'Deleted .cursorrules, which held only the old Hippo hook');
      }
    }

    return;
  }

  console.error('Usage: hippo hook <install|uninstall|list> [target]');
  process.exit(1);
}

function withoutHookBlock(text: string): string {
  const re = new RegExp(
    `\\n?${escapeRegex(HOOK_MARKERS.start)}[\\s\\S]*?${escapeRegex(HOOK_MARKERS.end)}\\n?`,
    'g'
  );
  return text.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
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

  for (const tool of skipped) {
    console.log(`  ${tool.name.padEnd(14)} not detected at ${tool.configDir} -- skipping`);
  }

  for (const tool of wrapperTools) {
    if (dryRun) {
      if (tool.name === 'codex') console.log(`[dry-run] would install Codex memory hooks in ${resolveJsonHookPaths('codex').settings}`);
      console.log(`[dry-run] would wrap the detected ${tool.name} launcher in place`);
      continue;
    }
    if (tool.name === 'codex') {
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

  if (!flags['no-learn']) {
    console.log('');
    printAgentImport(importUserMemories(globalRoot, { machine: currentMachine(), dryRun }), dryRun ? '[dry-run] ' : '');
  }

  console.log('');
  console.log('Done. Restart your AI tool to activate the hooks.');
}

function cmdDailyRunner(): void {
  const globalRoot = getGlobalRoot();
  // No workspace sleep ever opens the global store, yet hooks in folders without a store compact into it.
  if (isInitialized(globalRoot)) {
    const finished = replayCompactionsAt(globalRoot, (message) => console.error(`compaction replay: ${message}`));
    if (finished > 0) console.log(`Finished saving ${finished} compaction${finished === 1 ? '' : 's'} left over in the global store.`);
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
      console.error(`[hippo] daily-runner failed in ${cwd} during \`${action}\`: ${(err as Error).message}`);
    }
  });

  console.log(`Daily maintenance complete: ${processed} workspace${processed === 1 ? '' : 's'} processed, ${failed} command failure${failed === 1 ? '' : 's'}.`);
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
  // Absent stays undefined so the api default applies; the 0 fallback is unreachable.
  const budget = flags['budget'] === undefined ? undefined : parseBudgetFlag(flags['budget'], 0);
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
    cost: assembleCost(sessionId),
  });
  if (flags['json']) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log(settleTokens((t) => captureConsole(() => {
    console.log(assembleHeading({ ...r, items: r.items.length, tokens: t }));
    for (const it of r.items) {
      const prefix = it.isSummary ? '[summary]' : it.isFreshTail ? '[tail]' : '[older]';
      const head = it.content.slice(0, 120);
      console.log(`  ${prefix} ${it.createdAt} ${it.id} \u2014 ${head}${it.content.length > 120 ? '…' : ''}`);
    }
  })));
}

function cmdDrillDown(hippoRoot: string, summaryId: string, flags: Record<string, string | boolean | string[]>): void {
  requireInit(hippoRoot);
  const limit = typeof flags['limit'] === 'string' ? Number(flags['limit']) : undefined;
  // Absent stays undefined so the api default applies; the 0 fallback is unreachable.
  const budget = flags['budget'] === undefined ? undefined : parseBudgetFlag(flags['budget'], 0);
  // v0.30 / E5: --depth N walks N levels down (default 1, hard cap 10).
  // L4 fold: reject out-of-range explicitly (no silent clamp).
  const rawDepth = typeof flags['depth'] === 'string' ? Number(flags['depth']) : undefined;
  let depth: number | undefined;
  if (rawDepth !== undefined) {
    if (!Number.isInteger(rawDepth) || rawDepth < 1 || rawDepth > 10) {
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
    cost: drillCost,
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
  // The local CLI owns every tenant, so the revoke runs in the key's own tenant.
  const db = openHippoDb(root);
  let keyTenant: string | undefined;
  try {
    // SAFETY: row's shape matches the single tenant_id column in the SELECT.
    const row = db.prepare(`SELECT tenant_id FROM api_keys WHERE key_id = ?`).get(keyId) as { tenant_id: string } | undefined;
    keyTenant = row?.tenant_id;
  } finally {
    closeHippoDb(db);
  }
  if (keyTenant === undefined) {
    console.error(`Unknown key_id: ${keyId}`);
    process.exit(1);
  }
  const ctx: api.Context = { hippoRoot: root, tenantId: keyTenant, actor: api.adminActor('cli') };
  let revokedAt: string;
  try {
    revokedAt = api.authRevoke(ctx, keyId).revokedAt;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify({ keyId, revokedAt }));
    return;
  }
  console.log(`Revoked ${keyId} at ${revokedAt}`);
}

/** EI2: `hippo auth grant|ungrant <key_id> <scope>`, routed through api so the tenant, restricted-scope and audit checks live in one place. */
function cmdAuthScopeGrant(hippoRoot: string, keyId: string, scope: string, grant: boolean, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  // The local CLI owns every tenant (as auth revoke does), so the grant runs in the key's own tenant.
  const db = openHippoDb(root);
  let keyTenant: string | undefined;
  try {
    // SAFETY: row's shape matches the single tenant_id column in the SELECT.
    const row = db.prepare(`SELECT tenant_id FROM api_keys WHERE key_id = ?`).get(keyId) as { tenant_id: string } | undefined;
    keyTenant = row?.tenant_id;
  } finally {
    closeHippoDb(db);
  }
  if (keyTenant === undefined) {
    console.error(`Unknown key_id: ${keyId}`);
    process.exit(1);
  }
  const ctx: api.Context = { hippoRoot: root, tenantId: keyTenant, actor: api.adminActor('cli') };
  try {
    if (grant) api.authGrant(ctx, keyId, scope);
    else api.authUngrant(ctx, keyId, scope);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (flags['json']) {
    console.log(JSON.stringify({ keyId, scope, granted: grant }));
    return;
  }
  console.log(grant ? `Granted ${keyId} read access to ${scope}` : `Removed ${keyId}'s grant on ${scope}`);
}

// ---------------------------------------------------------------------------
// Audit log subcommands (A5 stub auth — `hippo audit list`)
// ---------------------------------------------------------------------------

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>(AUDIT_OPS);

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
    console.error('Usage: hippo auth <create|list|revoke|grant|ungrant> [options]');
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
    case 'grant':
    case 'ungrant': {
      const [keyId, scope] = subArgs;
      if (!keyId || !scope) {
        console.error(`Usage: hippo auth ${sub} <key_id> <scope>`);
        process.exit(1);
      }
      cmdAuthScopeGrant(hippoRoot, keyId, scope, sub === 'grant', flags);
      return;
    }
    default:
      console.error(`Unknown auth subcommand: ${sub}. Expected: create | list | revoke | grant | ungrant.`);
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

export function usageText(): string {
  return `
Hippo - memory for AI agents that learns what is wrong and ranks it down

Usage: hippo <command> [options]

Commands:
  init                     Create .hippo/ structure in current directory
    --scan [dir]           Find all git repos under dir (default: ~) and init each
    --days <n>             Days of git history to seed (default: 365 for --scan, 30 for single)
    --global               Init the global store ($HIPPO_HOME or ~/.hippo/)
    --no-hooks             Skip auto-detecting and installing agent hooks
                           (HIPPO_SKIP_AUTO_INTEGRATIONS=1 does the same)
    --no-schedule          Skip auto-creating the machine-level daily runner
    --no-learn             Skip seeding memories from git history and importing
                           coding agents' own memories (every init imports those)
  remember <text>          Store a memory
    --tag <tag>            Add a tag (repeatable)
    --error                Tag as error (boosts retention)
    --pin                  Pin memory (never decays)
    --verified             Set confidence: verified (default)
    --observed             Set confidence: observed
    --inferred             Set confidence: inferred
    --global               Store in global store ($HIPPO_HOME or ~/.hippo/)
  supersede <id> "<text>"  Replace a memory with a new version; the old one points at it
    --layer <layer>        Layer for the new memory (default: the old memory's layer)
    --tag <tag>            Tag for the new memory (repeatable; default: the old memory's tags)
    --pin                  Pin the new memory (default: pinned if the old one was)
  recall <query>           Search and retrieve memories (local + global)
    --budget <n>           Token budget for the whole printed block (default: 4000)
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
                           (cross-encoder|jev|llm). Looks up the named
                           reranker from src/rerankers/index.ts and re-orders
                           the top-K candidates. Default unset (no reranker).
                           jev calls the hosted TypeSafe Jev API: it needs
                           TYPESAFE_API_KEY, sends the query and candidate
                           text to that API, costs about 0.0004 USD a recall,
                           and falls back to cross-encoder on any failure.
                           See docs/evals/2026-09-19-jev-reranker.md and
                           docs/plans/2026-05-10-f6-reranker-hardening.md.
    --reranker-top-k <n>   Cap candidates passed to the reranker (default 50;
                           40 for jev).
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
    --budget <n>           Token budget, counted as recall prints (default: 4000)
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
    --budget <n>           Token budget for the whole printed block (default: 1500)
    --pinned-only          Only inject pinned memories (used by UserPromptSubmit hook)
    --include-recent <n>   With --pinned-only, also inject the last N writes regardless of pinning
    (the hook payload's "prompt" drives prompt recall instead of --include-recent when pinnedInject.promptRecall is on, the default)
    --format <fmt>         Output format: markdown (default), json, or additional-context (Claude Code hook JSON)
    --framing <mode>       Framing: observe (default), suggest, assert
  sleep                    Run consolidation pass (auto-learns + dedup + auto-shares)
                           Runs at Claude Code and OpenCode session end and in the daily job.
                           With ANTHROPIC_API_KEY set it sends memory text to Anthropic for
                           fact extraction; {"extraction":{"enabled":false}} turns that off
    --dry-run              Preview without writing
    --no-learn             Skip auto git-learn and the agent memory import before consolidation
    --no-share             Skip auto-sharing to global store
  daily-runner             Sweep registered workspaces and run daily learn+sleep
  dedup                    Remove duplicate memories (keeps stronger copy)
    --dry-run              Preview without removing
    --threshold <n>        Ignored, kept for old scripts: a duplicate is the same text apart from spacing
  status                   Show memory health stats
  audit [--fix]            Check memory quality (--fix removes junk)
  github                   GitHub connector subcommands (backfill, dlq)
    backfill --repo <owner/name> [--since ISO] [--max <N>]
                           Paginated backfill of issues + comments
    dlq list               List DLQ entries for the active tenant
    dlq replay <id> [--force]
                           Re-ingest a DLQ entry (--force skips sig check)
  slack                    Slack connector subcommands (backfill, dlq, workspaces)
    backfill --channel <id> [--since ISO]
                           Backfill a channel's history (needs SLACK_BOT_TOKEN)
    dlq list               List DLQ entries for the active tenant
    dlq replay <id> [--force]
                           Re-ingest a DLQ entry (--force skips sig check)
    workspaces <add|list|remove>
                           Map Slack workspaces (team ids) to tenants
  provenance               Provenance coverage gate for kind='raw' rows
    --json                 Output as JSON
    --strict               Exit non-zero when coverage < 100%
  dag                      Show the summary tree: entity profiles, topic summaries, facts
    --stats                Count memories per DAG level instead
  drill <summary-id>       Walk down a DAG level-2 summary to its children
    --limit N              Cap children list (default 50)
    --budget N             Token budget for the printed children (≈ chars/4)
    --json                 Output as JSON
  assemble --session <id>  Build a session's chronological context window
    --budget N             Token budget for the printed window (default 4000)
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
    --reject-loser         Tombstone the loser's value too (implies removal)
    --reason "<why>"       Reason for --reject-loser (default: conflict context)
  reject <memory-id>       Tombstone a value so it refuses re-ingestion
    reject --value "<t>"   Pre-emptive form: tombstone a value not (currently) stored
    --reason "<why>"       Required. The tombstone stores no content — this
                           is its only human-readable identity.
    --global               Reject in the global store
  rejections               List rejected-value tombstones for the active tenant
    --json                 Output as JSON
    --global               Operate on the global store
  unreject <digest-prefix> Delete a tombstone (the only escape hatch)
    --global               Operate on the global store
  dormant [<query>]        List faded memories sleep kept instead of deleting
                           (on by default; "dormant": {"enabled": false} deletes instead)
    --limit <n>            Max rows, newest first (default: 20)
    --json                 Output as JSON
    --global               Operate on the global store
    dormant restore <id>   Bring a dormant memory back to active memory
    dormant forget <id>    Delete a dormant memory permanently
  quarantine [list]        List memories a connector flagged as an instruction attempt, pending review
    --all                  Include approved and rejected rows too (default: pending only)
    --json                 Output as JSON
    --global               Operate on the global store
    quarantine approve <id> Restore a quarantined memory to its original scope
    quarantine reject <id>  Keep a quarantined memory hidden for good
  capture-error            Store a failed tool call as an error memory (reads the Claude Code
                           PostToolUseFailure hook payload on stdin; skips routine failures)
  doctor                   Check the install: Node, store, schema, sleep, agent hooks
    --json                 Machine-readable report (exit code 1 on any failure)
  support-bundle           Write a redacted JSON file for a support ticket: versions, doctor,
                           config without secrets, store counts, log names; never memory text
    --out <file>           Where to write it (default: hippo-support-<time>.json here)
    --include-logs         Add the last ${TAIL_MAX_LINES} lines of each hippo log, known secret shapes removed
  tokens                   Tokens of memory text hippo handed agents, per surface
                           (hook, compact-resume, context, recall, MCP, HTTP), what
                           skipping unchanged hook blocks saved, and how much of the
                           hook and compact-resume blocks later model calls re-read,
                           counted when a session ends. Estimates (characters / 4)
    --days <n>             Window in days (default: 30)
    --json                 Output as JSON
    --global               Operate on the global store
  failures                 Failed tool calls capture-error saw, by outcome, and how
                           many errors first happened in another session
    --days <n>             Window in days (default: 30)
    --json                 Output as JSON
    --global               Operate on the global store
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
      --constraint <text>  Constraint for the successor to respect (repeatable)
      --outcome <o>        success | failure | partial
      --target-runtime <n> Name of the runtime the successor will run in
      --card-id <id>       Associated card/ticket ID
      --tests <status>     pass | fail | unknown (default: unknown)
    handoff latest         Show the most recent handoff
      --session <id>       Filter by session
      --json               Output as JSON
    handoff show <id>      Show a specific handoff by ID
  card <sub>                Manage claimable work-queue cards
    card create             Create a new card
      --title <text>        Card title (required)
      --repo <name>         Associated repo
      --contract <text>     Associated contract
      --budget <n>           Token/step budget
      --depends-on <id>     Parent card id (repeatable)
    card show <id>          Show a card, its deps, runs, comments and latest handoff
      --json                 Output as JSON
    card list                List cards, newest-updated first
      --status <status>     Filter by status
    card claim <id>          Claim a ready or blocked card; prints its run id and lease
      --runtime <name>       Claiming runtime (required)
      --session <id>         Session ID
    card heartbeat <id>       Extend a running card's lease
      --run <n>              Your run id, as card claim printed it (required)
    card block <id>           Block a running card
      --reason "<why>"       Reason recorded as a card comment (required)
      --run <n>              Refuse unless <n> is the card's live run
    card review <id>          Move a running card to review
      --run <n>              Refuse unless <n> is the card's live run
    card complete <id>       Complete a card in review
      --outcome <o>          success | failure | partial (required)
      --run <n>              Refuse unless <n> is the card's live run
    card reclaim              Return every running card whose lease has expired to ready
    card comment <id>         Add a comment to a card
      --body <text>          Comment body (required)
      --author <name>       Comment author (default: cli)
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
    --agents               Sync every coding agent's own memories (Claude Code, Codex,
                             Gemini CLI, Copilot, OpenClaw, Qwen Code) now; with
                             --dry-run, print each tool's folders and what would change.
                             HIPPO_AGENT_MEMORY_TOOLS=<ids> or config agentMemories.tools
                             picks the tools; "none" or [] turns the import off
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
    --tag <tag>            Add extra tag (repeatable)
  export [file]            Export all memories (default: stdout)
    --format <fmt>         Output format: json (default) or markdown
  capture                  Extract memories from conversation text
    --stdin                Read from piped input
    --file <path>          Read from a file
    --last-session         Read the transcript a hook names on stdin, else the newest
                           Claude Code one from any project
    --transcript <path>    Explicit transcript path (implies --last-session)
    --log-file <path>      Tee output to a log file (paired with 'hippo last-sleep')
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
  setup                    One-shot: detect installed AI tools and install their hooks:
                           claude-code gets 7 hooks in ~/.claude/settings.json, opencode
                           a plugin, codex 2 hooks in its hooks.json plus a launcher
                           wrapper; other tools get a hint. Then imports each agent's
                           user-level memories into the global store
    --all                  Install for every JSON-hook tool, even if not detected
    --dry-run              Show what would be installed without writing
    --no-schedule          Skip installing or repairing the daily runner
    --no-learn             Skip the agent memory import
  last-sleep               Print the last 'hippo sleep --log-file' output to stderr and clear it
    --path <p>             Log path (default: ~/.hippo/logs/last-sleep.log)
    --keep                 Print without clearing
  session-end              SessionEnd hook: count this session's re-read tokens, run sleep, then
                           capture from the session's last 20 user and 10 assistant messages,
                           in a detached worker
    --log-file <path>      Tee the worker's output to a log file (paired with 'hippo last-sleep')
  pre-compact              PreCompact hook: record the compaction, save a working-state snapshot, and
                           ask the summariser to end with a "Memories for hippo" list
    --log-file <p>         Diagnostic log path (default: ~/.hippo/logs/pre-compact.log)
  compact-resume           SessionStart(compact) hook: re-print the snapshot, if under 15 minutes old
  post-compact             PostCompact hook: keep that list as memories (a busy store leaves the save to
                           the next hippo sleep) and print one line saying how many
    --log-file <p>         Same log path as pre-compact (default: ~/.hippo/logs/pre-compact.log)
  codex-run [-- ...args]   Launch real Codex behind Hippo's session-end wrapper
  hook <sub> [target]      Manage framework integrations
    hook list              Show available hooks
    hook install <target>  Install hook (claude-code|codex|cursor|openclaw|opencode|pi)
                           claude-code adds 7 hooks to ~/.claude/settings.json;
                           opencode installs a plugin; codex adds 2 hooks to
                           $CODEX_HOME/hooks.json (trust them once in /hooks) and
                           wraps the detected launcher in place; all but claude-code
                           also patch an existing AGENTS.md
    hook uninstall <target> Remove hook
  predict "<claim>"        Record a prediction to score against the actual outcome later
    --class <c>            Reference class (required)
    --estimate <v>         Numeric estimate
    --unit <u>             Unit of the estimate
    --target <YYYY-MM-DD>  When the outcome is due
  predict close <id>       Close a prediction
    --state <s>            closed | closed-unknown (required)
    --actual <v>           The actual value
    --note "<text>"        Closure note
  predict list [--class <c>] [--status open|closed|closed-unknown|all] [--limit N]
                           List predictions (closed and closed-unknown need --class)
  predict show <id>        Show one prediction
  predict baserate --class <c>
                           How past estimates in a class compared with the actuals
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
                           (content overlap, or a tag EXACTLY equal to the
                           full pattern - never token-level tag matching)
    --id <memory-id>       Invalidate exactly one memory (instead of a pattern)
    --dry-run              Preview what would be hit; writes nothing
                           Note: a pattern equal to the system tag
                           'invalidated' re-weakens previously invalidated
                           memories - preview with --dry-run first
    --reason "<why>"       Optional: what replaced it
  invalidate --churn       FE2: tag memories 'churn-stale' whose named file
                           changed or was deleted, or whose named symbol or
                           npm script was removed, in this repo's git history
                           since the memory was stored or confirmed
    --dry-run              Preview what would be tagged; writes nothing
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
    wm flush               Same as clear; nothing runs it at session end
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
  dashboard                Open web dashboard for memory health
    --port <n>             Port to serve on (default: 3333)
  mcp                      Start MCP server (stdio transport)
  serve                    Start the HTTP API server for this store (Ctrl+C stops it)
    --port <n>             Port to serve on (default: $HIPPO_PORT or 6789)
    --host <host>          Address to bind (default: 127.0.0.1)
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
    auth grant <key_id> <scope>    Let a member key read one restricted scope
      --json               Output as JSON
      --global             Operate on the global store
    auth ungrant <key_id> <scope>  Remove a scope grant
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
  hippo reject mem_abc123 --reason "leaked credential"
  hippo reject --value "never store my key again" --reason "secret"
  hippo rejections
  hippo unreject a1b2c3d4e5f6
  hippo dormant "staging hostname"
  hippo dormant restore mem_abc123
  hippo tokens --days 7
  hippo session log --id sess_123 --task "Ship feature" --type progress --content "Build is green, next step is docs"
  hippo session latest --json
  hippo session resume
  hippo snapshot save --task "Ship feature" --summary "Tests are green" --next-step "Open the PR" --session sess_123
  hippo handoff create --summary "PR is open, tests green" --next "Merge after review" --session sess_123 --artifact src/foo.ts
  hippo handoff create --summary s --constraint a --constraint b --outcome partial --target-runtime codex --card-id c1 --tests pass
  hippo card create --title "Add cards table" --repo hippo --depends-on card_abc
  hippo card claim card_abc --runtime codex
  hippo card complete card_abc --outcome success
  hippo card heartbeat card_abc --run 7
  hippo card reclaim
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
  hippo invalidate "REST API" --dry-run
  hippo invalidate "REST API" --reason "migrated to GraphQL"
  hippo invalidate --id mem_a1b2c3d4e5f6 --reason "superseded by new policy"
  hippo invalidate --churn --dry-run
  hippo export memories.json
  hippo export --format markdown memories.md
  hippo sleep --dry-run
  hippo outcome --good
  hippo status
`;
}

function printUsage(): void {
  console.log(usageText());
}

const USAGE_ALIASES: ReadonlyMap<string, string> = new Map([['project-brief', 'brief'], ['customer-note', 'note']]);

// Cut from usageText() so a verb's help can never drift from the full listing.
export function verbUsage(verb: string): string | null {
  const name = USAGE_ALIASES.get(verb) ?? verb;
  const block: string[] = [];
  let inBlock = false;
  for (const line of usageText().split('\n')) {
    if (/^ {2}\S/.test(line)) inBlock = line.trimStart().split(' ', 1)[0] === name;
    else if (!line.startsWith('    ')) inBlock = false;
    if (inBlock) block.push(line);
  }
  return block.length > 0 ? block.join('\n') : null;
}

// These sub-commands have fuller usage text than their lines in usageText().
const SUBCOMMAND_USAGE: ReadonlyMap<string, () => void> = new Map([
  ['audit prune', printAuditPruneUsage],
  ['slack backfill', printSlackBackfillUsage],
  ['slack workspaces', printSlackWorkspacesUsage],
  ['github backfill', printGithubBackfillUsage],
]);

function printHelp(command: string, args: string[]): void {
  const printSubcommandUsage = SUBCOMMAND_USAGE.get(`${command} ${args[0] ?? ''}`);
  if (printSubcommandUsage) printSubcommandUsage();
  else console.log(verbUsage(command) ?? usageText());
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(
  command: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  hippoRoot: string,
): Promise<void> {
  if (command === '--version' || command === '-v' || flags['version']) {
    const __filename_local = fileURLToPath(import.meta.url);
    const __dirname_local = path.dirname(__filename_local);
    const pkgJson = fs.readFileSync(path.join(__dirname_local, '..', 'package.json'), 'utf-8');
    const { version } = JSON.parse(pkgJson) as { version: string };
    console.log(version);
    process.exit(0);
  }
  if (command === '' || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }
  // Before every other step, so help never opens a store, installs a hook or starts a server.
  if (Object.hasOwn(flags, 'help')) {
    printHelp(command, args);
    return;
  }
  maybeRepairCodexWrapper(command, flags);
  /** Global --scope well-formedness guard (v1.26.2). parseArgs stores a value-less
   *  flag as boolean true; downstream the 14 consumer sites either coerced that to
   *  the literal scope string 'true' (recall filter/unlock input, wm session scope,
   *  the remember scope-tag dual-write) or silently dropped the user's scoping
   *  intent (the remember envelope WRITE). Reject it once here, mirroring the
   *  --hops value-less guard, so every current and future command - including the
   *  thin-client dispatch relays - sees --scope only as a non-empty string. */
  if ('scope' in flags && (typeof flags['scope'] !== 'string' || !flags['scope'].trim())) {
    console.error('--scope requires a non-empty value (e.g. --scope slack:private:C1).');
    process.exit(1);
  }
  // parseArgs stores a value-less flag as boolean true, and NaN then survives every
  // downstream guard because each comparison against it is false.
  const NUMERIC_FLAGS = [
    'days', 'threshold', 'min-score', 'port', 'limit', 'mmr-lambda', 'local-bump',
    'min-results', 'reranker-top-k', 'min-mrr', 'embedding-weight', 'max-cases',
  ];
  for (const key of NUMERIC_FLAGS) {
    const raw = flags[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Number(raw))) {
      console.error(`--${key} requires a numeric value.`);
      process.exit(1);
    }
  }
  // Reject rather than coerce: consumers read --dry-run both as Boolean() and === true,
  // so no single coercion of an inline value would be correct for every one of them.
  for (const key of BOOLEAN_FLAGS) {
    if (Object.hasOwn(flags, key) && typeof flags[key] !== 'boolean') {
      console.error(`--${key} takes no value`);
      process.exit(1);
    }
  }
  // card checks its flags per subcommand, with a stricter message.
  const unknownFlags = command === 'card' ? [] : Object.keys(flags).filter((key) => !KNOWN_FLAGS.has(key));
  if (unknownFlags.length > 0) {
    const names = unknownFlags.map((key) => `--${key}`).join(', ');
    if (DESTRUCTIVE_COMMANDS.has(command)) {
      console.error(`Unknown flag ${names} for hippo ${command}. Nothing was changed.`);
      process.exit(2);
    }
    console.error(`hippo: ignoring unknown flag ${names}. A later release will reject it.`);
  }
  const refusal = Object.hasOwn(flags, 'dry-run') ? dryRunRefusal(command, args, flags) : null;
  if (refusal) {
    console.error(refusal);
    process.exit(2);
  }
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
      // flags (--pin, --layer, --extract, --global) still need the direct
      // path; we only intercept the minimal envelope. The salience gate is
      // NOT in richFlag and the route does not apply it, so a routed remember
      // stores what a direct one would skip. Measured 2026-09-07, tracked in
      // TODOS.md; do not read this list as covering salience.
      const richFlag =
        flags['pin'] || flags['global'] || flags['extract'] || flags['force'] ||
        flags['observed'] || flags['inferred'] || flags['verified'] ||
        flags['layer'] !== undefined;
      if (!richFlag) {
        const rememberKindRaw = typeof flags['kind'] === 'string' ? (flags['kind'] as string).toLowerCase() : undefined;
        const rememberKindAllowed = ['distilled', 'superseded'] as const;
        if (rememberKindRaw === undefined || (rememberKindAllowed as readonly string[]).includes(rememberKindRaw)) {
          const tags = rememberTags(flags, process.cwd()).all;
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
            for (const w of result.warnings ?? []) console.error(`Warning: ${w}`);
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
      await cmdRecall(hookStoreRoot(hippoRoot), query, flags);
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
      await (await import('./cli/sleep.js')).cmdSleep(hippoRoot, flags);
      break;

    case 'last-sleep':
      cmdLastSleep(flags);
      break;

    case 'session-end':
      await cmdSessionEnd(hippoRoot, flags);
      break;

    case '__session-end-worker':
      await cmdSessionEndWorker(hippoRoot, flags);
      break;

    case 'pre-compact': {
      // Bounded wait, not a TTY guard: an idle non-TTY pipe must not hang.
      const { text: stdinText, timedOut: stdinTimedOut } = await readStdinBounded();
      await runHookWithStores(async () => {
        resetHookInjection(hippoRoot, stdinText, null);
        await cmdPreCompact(hookStoreRoot(hippoRoot), {
          stdinText,
          stdinTimedOut,
          logFile: typeof flags['log-file'] === 'string' ? (flags['log-file'] as string) : undefined,
        });
      });
      break;
    }

    case 'post-compact': {
      // PostCompact hook: saves the compaction summary and its memories, then prints one plain line, because Claude Code shows this hook's stdout as-is. Always exits 0.
      const { text } = await readStdinBounded();
      const logFlag = flags['log-file'];
      const store = hookStoreRoot(hippoRoot);
      const line = await runHookWithStores(() => cmdPostCompact(store, {
        stdinText: text,
        logFile: logFlag === true || logFlag === false || Array.isArray(logFlag) ? undefined : logFlag,
        // Passed in, since capture.ts importing the sync would close an import cycle.
        afterSave: (transcriptPath, originProject, log) => {
          const report = importAtCompaction(store, transcriptPath, originProject, { machine: currentMachine(), busyWaitMs: COMPACTION_DB_WAIT_MS });
          const summary = summaryLine(report);
          if (summary !== null) log(summary);
          for (const warning of report.warnings) log(`agent memories: ${warning}`);
        },
      }));
      if (line !== null && line !== undefined) console.log(line);
      break;
    }

    case 'capture-error': {
      // PostToolUseFailure hook: every path exits 0, and nothing is created
      // when no store exists (the hook fires in every directory).
      const { text } = await readStdinBounded();
      try {
        const root = hookStoreRoot(hippoRoot);
        const payload = (text ?? '').trim();
        if (isInitialized(root) && payload) {
          // SAFETY: JSON.parse returns a JSON value by definition.
          const failure = JSON.parse(payload) as JsonValue;
          await runHookWithStores(() => captureToolFailure(root, resolveTenantId({}), failure));
        }
      } catch {
        // A malformed payload or store error must never fail the agent's tool call.
      }
      break;
    }

    case 'compact-resume': {
      const { text: stdinText, timedOut: stdinTimedOut } = await readStdinBounded();
      await runHookWithStores(() => {
        resetHookInjection(hippoRoot, stdinText, 'compact');
        cmdCompactResume(hookStoreRoot(hippoRoot), stdinText, stdinTimedOut);
      });
      break;
    }

    case 'codex-run':
      cmdCodexRun(hippoRoot, args);
      break;

    case '__codex-session-end-worker':
      await cmdCodexSessionEndWorker(hippoRoot, flags);
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
      const entries = loadAllEntries(hippoRoot, resolveTenantId({}));
      const result = auditMemories(entries, memoriesBackingObjects(hippoRoot));
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
          const errors = result.issues.filter(i => i.severity === 'error');
          if (errors.length > 0 && flags['dry-run'] === true) {
            console.log(`\nWould remove ${errors.length} error-severity memories (dry run, nothing deleted).`);
            console.log(`${result.issues.length - errors.length} warnings would remain (review manually).`);
          } else if (errors.length > 0) {
            const removedCount = errors.filter((issue) =>
              deleteEntry(hippoRoot, issue.memoryId, { reason: `audit --fix: ${issue.reason}`, automatic: true })).length;
            console.log(`\nRemoved ${removedCount} error-severity memories.`);
            console.log(`${result.issues.length - errors.length} warnings remain (review manually).`);
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

    case 'reject':
      cmdReject(hippoRoot, args, flags);
      break;

    case 'rejections':
      cmdRejections(hippoRoot, flags);
      break;

    case 'unreject':
      cmdUnreject(hippoRoot, args, flags);
      break;

    case 'dormant':
      cmdDormant(hippoRoot, args, flags);
      break;

    case 'quarantine':
      cmdQuarantine(hippoRoot, args, flags);
      break;

    case 'tokens':
      cmdTokens(hippoRoot, flags);
      break;

    case 'failures':
      cmdFailures(hippoRoot, flags);
      break;

    case 'doctor': {
      // SAFETY: package.json always carries a string "version" (checked at release by check-manifest-versions).
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8')) as { version: string };
      const report = runDoctor({ version: pkg.version });
      console.log(flags['json'] ? JSON.stringify(report, null, 2) : formatDoctor(report));
      if (!report.ok) process.exit(1);
      break;
    }

    case 'support-bundle': {
      const outFlag = cardStringFlag(flags, 'out');
      if (outFlag === '') {
        console.error('--out requires a file path.');
        process.exit(1);
      }
      const includeLogs = flags['include-logs'] === true;
      const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
      const now = new Date();
      const bundle = buildSupportBundle({ cwd: process.cwd(), home, version: PACKAGE_VERSION, includeLogs, now });
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      const file = outFlag ?? path.join(process.cwd(), `hippo-support-${stamp}.json`);
      const json = JSON.stringify(bundle, null, 2);
      try {
        fs.writeFileSync(file, `${json}\n`, { flag: 'wx', mode: 0o600 });
      } catch (err) {
        if (err instanceof Error && 'code' in err && err.code === 'EEXIST') {
          console.error(`${file} already exists; pass --out to choose another file. Nothing was written.`);
        } else {
          console.error(err instanceof Error ? err.message : String(err));
        }
        process.exit(1);
      }
      const kb = Math.round(Buffer.byteLength(json) / 1024);
      console.log(`Wrote ${file} (${kb} KB).`);
      console.log(includeLogs
        ? `It holds versions, doctor checks, config with secrets removed, store counts, and the last ${TAIL_MAX_LINES} lines of each hippo log with known secret shapes removed. Those log lines can quote memory text. Read it before you attach it to a ticket.`
        : 'It holds versions, doctor checks, config with secrets removed, store counts and log file names. It never holds memory text. Read it before you attach it to a ticket.');
      break;
    }

    case 'snapshot':
      cmdSnapshot(hippoRoot, args, flags);
      break;

    case 'session':
      cmdSession(hippoRoot, args, flags);
      break;

    case 'handoff':
      cmdHandoff(hippoRoot, args, flags);
      break;

    case 'card':
      cmdCard(hippoRoot, args, flags);
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
      // Archive has its own HTTP route (POST /v1/memories/:id/archive); route
      // both branches the same way the direct path does.
      const archive = flags['archive'] === true;
      const reason = typeof flags['reason'] === 'string' ? flags['reason'] : null;
      if (archive && !reason) {
        console.error(ARCHIVE_REASON_REQUIRED);
        process.exit(1);
      }
      if (flags['dry-run'] === true) {
        previewForget(hippoRoot, id, archive);
        break;
      }
      const routed = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
        try {
          if (archive) {
            await client.archiveRaw(info.url, apiKey, id, reason!);
            console.log(`Archived ${id}`);
          } else {
            await client.forget(info.url, apiKey, id);
            console.log(`Forgot ${id}`);
          }
        } catch (err) {
          // A server that died after the health probe is the caller's transport
          // fallback to handle, not an error to report to the user.
          if (client.classifyTransportFailure(err) !== 'none') throw err;
          const msg = err instanceof Error ? err.message : String(err);
          console.error(archive ? `Could not archive ${id}: ${msg}` : msg);
          process.exit(1);
        }
      });
      if (routed) break;
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

    case 'context': {
      // Bounded, not a TTY guard (DF1 T2, docs/plans/2026-08-23-df1-snapshot-lifecycle.md):
      // the hot stdin path and a manual run share this one command.
      const { text: stdinText } = await readStdinBounded();
      await runHookWithStores(() => cmdContext(hookStoreRoot(hippoRoot), args, flags, stdinText));
      break;
    }

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
      cmdSync(hippoRoot, flags);
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
      const entries = loadAllEntries(hippoRoot, resolveTenantId({}));

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

      // Bounded, and only when last-session has no explicit path: the
      // --stdin source keeps its own blocking read in capture.ts by design.
      const bounded = captureSource === 'last-session' && !transcriptPath
        ? await readStdinBounded()
        : { text: undefined, timedOut: false };

      cmdCapture(hippoRoot, {
        source: captureSource,
        filePath: captureFile,
        transcriptPath,
        stdinText: bounded.text,
        stdinTimedOut: bounded.timedOut,
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
      const handle = await serve({ hippoRoot, port, host, handleSignals: true });
      console.log(`hippo serve listening on ${handle.url} (pid ${process.pid})`);
      console.log(`pidfile: ${path.join(hippoRoot, 'server.pid')}`);
      console.log('press Ctrl+C to stop');
      // The SIGINT/SIGTERM handlers stop the server and exit. Hang until then.
      await new Promise(() => {});
      break;
    }

    case 'invalidate': {
      requireInit(hippoRoot);
      if (flags['churn'] === true) {
        if (args[0] || flags['id'] !== undefined) {
          console.error('Usage: hippo invalidate --churn [--dry-run]');
          console.error('--churn takes no pattern or --id.');
          process.exit(1);
        }
        if (!isGitRepo(process.cwd())) {
          console.error('hippo invalidate --churn must run inside a git repository.');
          process.exit(1);
        }
        const churnDryRun = flags['dry-run'] === true;
        let churnFailed = false;
        for (const { root, result } of runChurnStaleForRepo(hippoRoot, churnDryRun)) {
          if (result.error) {
            console.error(`Churn-staleness check failed for ${root}: ${result.error}`);
            churnFailed = true;
            continue;
          }
          if (result.preview.length === 0) {
            console.log(`No churn-stale candidates in ${root}.`);
          } else if (churnDryRun) {
            console.log(`DRY RUN - ${result.marked} memories in ${root} WOULD be tagged churn-stale (${result.alreadyMarked} already tagged):`);
          } else {
            console.log(`Tagged ${result.marked} memories churn-stale in ${root} (${result.alreadyMarked} already tagged):`);
          }
          result.preview.forEach(p => console.log(`   ${p.id}  ${p.evidence}  ${p.already ? '(already) ' : ''}${p.headline}`));
          if (result.skippedPinned.length > 0) {
            console.log(`Skipped ${result.skippedPinned.length} pinned: ${result.skippedPinned.join(', ')}`);
          }
        }
        if (churnFailed) process.exit(1);
        break;
      }
      const target = args[0];
      if (flags['id'] === true) {
        // Value-less --id must never silently fall through to pattern mode
        // (pattern mode writes broadly; an ignored --id reverses user intent).
        console.error('--id requires a memory id');
        process.exit(1);
      }
      const onlyId = typeof flags['id'] === 'string' ? (flags['id'] as string) : undefined;
      if (typeof flags['dry-run'] === 'string') {
        // Dead: the earlier global BOOLEAN_FLAGS guard now exits first on any --dry-run=<v>.
        // Kept as defence in depth on a destructive command.
        console.error('--dry-run takes no value');
        process.exit(1);
      }
      const dryRun = flags['dry-run'] === true;
      if ((target && onlyId) || (!target && !onlyId)) {
        console.error('Usage: hippo invalidate "<old pattern>" [--dry-run] [--reason "<why>"]');
        console.error('       hippo invalidate --id <memory-id> [--dry-run] [--reason "<why>"]');
        console.error('Pass a pattern OR --id, not both. Tag matching is EXACT: the full pattern must equal a tag.');
        process.exit(1);
      }
      const reason = flags['reason'] as string || null;
      const invTarget: InvalidationTarget = {
        from: target ?? `id:${onlyId}`,
        to: reason,
        type: 'migration',
      };
      const result = invalidateMatching(hippoRoot, invTarget, resolveTenantId({}), { dryRun, onlyId });
      const label = target ? `"${target}"` : `--id ${onlyId}`;
      if (result.dryRun) {
        if (result.invalidated === 0) {
          console.log(`DRY RUN - no memories would match ${label}.`);
        } else {
          console.log(`DRY RUN - ${result.invalidated} memories WOULD be invalidated:`);
          result.preview.forEach(p => console.log(`   ${p.id}  ${p.headline}`));
        }
      } else if (result.invalidated === 0) {
        console.log(`No memories matched ${label}.`);
      } else {
        console.log(`Invalidated ${result.invalidated} memories referencing ${label}.`);
        result.targets.forEach(id => console.log(`   ${id}`));
      }
      if (result.skippedPinned.length > 0) {
        console.log(`Skipped ${result.skippedPinned.length} pinned: ${result.skippedPinned.join(', ')}`);
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

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);
  try {
    await main(command, args, flags, getHippoRoot(process.cwd()));
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// bin/hippo.js calls runCli(); this keeps `node dist/cli.js` working while an import runs nothing.
const entryPath = process.argv[1];
if (entryPath && fs.existsSync(entryPath) && fs.realpathSync(entryPath) === fileURLToPath(import.meta.url)) {
  void runCli();
}
