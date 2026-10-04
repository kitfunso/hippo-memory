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
 *   hippo projects [--json] | merge <from> <into> [--apply] | repair [--apply]
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

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { repairCodexWrapperIfInstalled } from './hooks/codex-wrapper.js';
import { getHippoRoot } from './store/open.js';
import { cmdGithub, printGithubBackfillUsage } from './connectors/github/cli-impl.js';
import { printError } from './cli/output.js';
import type { CommandContext } from './cli/shared.js';
import { VERB_USAGE, USAGE_HEADER, USAGE_EXAMPLES, printAuditPruneUsage, printSlackBackfillUsage, printSlackWorkspacesUsage } from './cli/usage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Every switch the CLI reads. A value on one reads as on under Boolean() (`--fix=false` would fix)
// and as off under === true (`--pin=true` would not pin), so parseArgs and main() refuse one.
// tests/cli-parse-flag-equals.test.ts fails when a switch read is missing from this set.
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'agents', 'all', 'all-tenants', 'apply', 'archive', 'auto', 'bad', 'bootstrap', 'classic', 'churn', 'continuity',
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
  'audit', 'dedup', 'forget', 'invalidate', 'projects', 'reject', 'resolve', 'sleep', 'supersede',
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

interface CommandSpec {
  readonly run: (ctx: CommandContext) => void | Promise<void>;
  readonly aliases?: readonly string[];
  // Each block opens with a newline so the full listing is their concatenation.
  readonly usage: readonly string[];
}

/** Every verb main() dispatches, keyed by name, with its handler, aliases and help blocks. */
export const COMMANDS = {
  init: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/init.js')).cmdInit(hippoRoot, flags); },
    usage: VERB_USAGE.init,
  },
  remember: {
    run: async (c) => { await (await import('./cli/remember.js')).handleRemember(c); },
    usage: VERB_USAGE.remember,
  },
  recall: {
    run: async (c) => { await (await import('./cli/recall.js')).handleRecall(c); },
    usage: VERB_USAGE.recall,
  },
  drill: {
    run: async (c) => { await (await import('./cli/dag.js')).handleDrill(c); },
    usage: VERB_USAGE.drill,
  },
  assemble: {
    run: async (c) => { await (await import('./cli/dag.js')).handleAssemble(c); },
    usage: VERB_USAGE.assemble,
  },
  supersede: {
    run: async (c) => { await (await import('./cli/remember.js')).handleSupersede(c); },
    usage: VERB_USAGE.supersede,
  },
  explain: {
    run: async (c) => { await (await import('./cli/explain.js')).handleExplain(c); },
    usage: VERB_USAGE.explain,
  },
  eval: {
    run: async (c) => { await (await import('./cli/eval.js')).handleEval(c); },
    usage: VERB_USAGE.eval,
  },
  trace: {
    run: async (c) => { await (await import('./cli/remember.js')).handleTrace(c); },
    usage: VERB_USAGE.trace,
  },
  refine: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/maintenance.js')).cmdRefine(hippoRoot, flags); },
    usage: VERB_USAGE.refine,
  },
  sleep: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/sleep.js')).cmdSleep(hippoRoot, flags); },
    usage: VERB_USAGE.sleep,
  },
  'last-sleep': {
    run: async ({ flags }) => { (await import('./cli/session-hooks.js')).cmdLastSleep(flags); },
    usage: VERB_USAGE['last-sleep'],
  },
  'session-end': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdSessionEnd(hippoRoot, flags); },
    usage: VERB_USAGE['session-end'],
  },
  '__session-end-worker': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdSessionEndWorker(hippoRoot, flags); },
    usage: [],
  },
  'pre-compact': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handlePreCompact(c); },
    usage: VERB_USAGE['pre-compact'],
  },
  'post-compact': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handlePostCompact(c); },
    usage: VERB_USAGE['post-compact'],
  },
  'capture-error': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCaptureError(c); },
    usage: VERB_USAGE['capture-error'],
  },
  'compact-resume': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCompactResume(c); },
    usage: VERB_USAGE['compact-resume'],
  },
  'codex-run': {
    run: async ({ hippoRoot, args }) => { (await import('./cli/session-hooks.js')).cmdCodexRun(hippoRoot, args); },
    usage: VERB_USAGE['codex-run'],
  },
  '__codex-session-end-worker': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdCodexSessionEndWorker(hippoRoot, flags); },
    usage: [],
  },
  dedup: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/maintenance.js')).cmdDedup(hippoRoot, flags); },
    usage: VERB_USAGE.dedup,
  },
  dag: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/dag.js')).cmdDag(hippoRoot, flags); },
    usage: VERB_USAGE.dag,
  },
  auth: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/auth.js')).cmdAuth(hippoRoot, args, flags); },
    usage: VERB_USAGE.auth,
  },
  goal: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/goals.js')).cmdGoal(hippoRoot, args, flags); },
    usage: VERB_USAGE.goal,
  },
  slack: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/slack.js')).cmdSlack(hippoRoot, args, flags); },
    usage: VERB_USAGE.slack,
  },
  github: {
    run: async ({ hippoRoot, args, flags }) => { await cmdGithub(hippoRoot, args, flags); },
    usage: VERB_USAGE.github,
  },
  audit: {
    run: async (c) => { await (await import('./cli/audit.js')).handleAudit(c); },
    usage: VERB_USAGE.audit,
  },
  'correction-latency': {
    run: async (c) => { await (await import('./cli/status.js')).handleCorrectionLatency(c); },
    usage: VERB_USAGE['correction-latency'],
  },
  provenance: {
    run: async (c) => { await (await import('./cli/status.js')).handleProvenance(c); },
    usage: VERB_USAGE.provenance,
  },
  status: {
    run: async ({ hippoRoot }) => { (await import('./cli/status.js')).cmdStatus(hippoRoot); },
    usage: VERB_USAGE.status,
  },
  outcome: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdOutcome(hippoRoot, flags); },
    usage: VERB_USAGE.outcome,
  },
  conflicts: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdConflicts(hippoRoot, flags); },
    usage: VERB_USAGE.conflicts,
  },
  resolve: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdResolve(hippoRoot, args, flags); },
    usage: VERB_USAGE.resolve,
  },
  reject: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdReject(hippoRoot, args, flags); },
    usage: VERB_USAGE.reject,
  },
  rejections: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdRejections(hippoRoot, flags); },
    usage: VERB_USAGE.rejections,
  },
  unreject: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdUnreject(hippoRoot, args, flags); },
    usage: VERB_USAGE.unreject,
  },
  dormant: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdDormant(hippoRoot, args, flags); },
    usage: VERB_USAGE.dormant,
  },
  projects: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/projects.js')).cmdProjects(hippoRoot, args, flags); },
    usage: VERB_USAGE.projects,
  },
  quarantine: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdQuarantine(hippoRoot, args, flags); },
    usage: VERB_USAGE.quarantine,
  },
  tokens: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/status.js')).cmdTokens(hippoRoot, flags); },
    usage: VERB_USAGE.tokens,
  },
  failures: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/status.js')).cmdFailures(hippoRoot, flags); },
    usage: VERB_USAGE.failures,
  },
  doctor: {
    run: async (c) => { await (await import('./cli/status.js')).handleDoctor(c); },
    usage: VERB_USAGE.doctor,
  },
  'support-bundle': {
    run: async (c) => { await (await import('./cli/status.js')).handleSupportBundle(c); },
    usage: VERB_USAGE['support-bundle'],
  },
  snapshot: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdSnapshot(hippoRoot, args, flags); },
    usage: VERB_USAGE.snapshot,
  },
  session: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdSession(hippoRoot, args, flags); },
    usage: VERB_USAGE.session,
  },
  handoff: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdHandoff(hippoRoot, args, flags); },
    usage: VERB_USAGE.handoff,
  },
  card: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/card.js')).cmdCard(hippoRoot, args, flags); },
    usage: VERB_USAGE.card,
  },
  predict: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdPredict(hippoRoot, args, flags); },
    usage: VERB_USAGE.predict,
  },
  current: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdCurrent(hippoRoot, args, flags); },
    usage: VERB_USAGE.current,
  },
  forget: {
    run: async (c) => { await (await import('./cli/curate.js')).handleForget(c); },
    usage: VERB_USAGE.forget,
  },
  inspect: {
    run: async (c) => { await (await import('./cli/status.js')).handleInspect(c); },
    usage: VERB_USAGE.inspect,
  },
  context: {
    run: async (c) => { await (await import('./cli/context.js')).handleContext(c); },
    usage: VERB_USAGE.context,
  },
  hook: {
    run: async ({ args, flags }) => { (await import('./cli/setup.js')).cmdHook(args, flags); },
    usage: VERB_USAGE.hook,
  },
  setup: {
    run: async ({ flags }) => { (await import('./cli/setup.js')).cmdSetup(flags); },
    usage: VERB_USAGE.setup,
  },
  'daily-runner': {
    run: async () => { (await import('./cli/setup.js')).cmdDailyRunner(); },
    usage: VERB_USAGE['daily-runner'],
  },
  embed: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/maintenance.js')).cmdEmbed(hippoRoot, flags); },
    usage: VERB_USAGE.embed,
  },
  watch: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleWatch(c); },
    usage: VERB_USAGE.watch,
  },
  learn: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/transfer.js')).cmdLearn(hippoRoot, flags); },
    usage: VERB_USAGE.learn,
  },
  promote: {
    run: async (c) => { await (await import('./cli/transfer.js')).handlePromote(c); },
    usage: VERB_USAGE.promote,
  },
  sync: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/transfer.js')).cmdSync(hippoRoot, flags); },
    usage: VERB_USAGE.sync,
  },
  share: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleShare(c); },
    usage: VERB_USAGE.share,
  },
  peers: {
    run: async (c) => { await (await import('./cli/transfer.js')).handlePeers(c); },
    usage: VERB_USAGE.peers,
  },
  import: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/transfer.js')).cmdImport(hippoRoot, args, flags); },
    usage: VERB_USAGE.import,
  },
  export: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleExport(c); },
    usage: VERB_USAGE.export,
  },
  capture: {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCapture(c); },
    usage: VERB_USAGE.capture,
  },
  dashboard: {
    run: async (c) => { await (await import('./cli/serve.js')).handleDashboard(c); },
    usage: VERB_USAGE.dashboard,
  },
  wm: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdWm(hippoRoot, args, flags); },
    usage: VERB_USAGE.wm,
  },
  mcp: {
    run: async () => { await (await import('./cli/serve.js')).handleMcp(); },
    usage: VERB_USAGE.mcp,
  },
  serve: {
    run: async (c) => { await (await import('./cli/serve.js')).handleServe(c); },
    usage: VERB_USAGE.serve,
  },
  invalidate: {
    run: async (c) => { await (await import('./cli/curate.js')).handleInvalidate(c); },
    usage: VERB_USAGE.invalidate,
  },
  decide: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdDecide(hippoRoot, args, flags); },
    usage: VERB_USAGE.decide,
  },
  incident: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdIncident(hippoRoot, args, flags); },
    usage: VERB_USAGE.incident,
  },
  process: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdProcess(hippoRoot, args, flags); },
    usage: VERB_USAGE.process,
  },
  policy: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdPolicy(hippoRoot, args, flags); },
    usage: VERB_USAGE.policy,
  },
  skill: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdSkill(hippoRoot, args, flags); },
    usage: VERB_USAGE.skill,
  },
  brief: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdProjectBrief(hippoRoot, args, flags); },
    aliases: ['project-brief'],
    usage: VERB_USAGE.brief,
  },
  note: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdCustomerNote(hippoRoot, args, flags); },
    aliases: ['customer-note'],
    usage: VERB_USAGE.note,
  },
  graph: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdGraph(hippoRoot, args, flags); },
    usage: VERB_USAGE.graph,
  },
} satisfies Record<string, CommandSpec>;

const COMMAND_INDEX: ReadonlyMap<string, CommandSpec> = new Map(
  Object.entries<CommandSpec>(COMMANDS).flatMap(([verb, spec]) =>
    [verb, ...(spec.aliases ?? [])].map((name): [string, CommandSpec] => [name, spec])),
);

// The full listing order; a verb listed twice prints its next help block.
const USAGE_ORDER: readonly (keyof typeof COMMANDS)[] = [
  'init', 'remember', 'supersede', 'recall', 'explain', 'trace', 'refine', 'eval', 'context', 'sleep',
  'daily-runner', 'dedup', 'status', 'audit', 'github', 'slack', 'provenance', 'dag', 'drill', 'assemble',
  'correction-latency', 'outcome', 'conflicts', 'resolve', 'reject', 'rejections', 'unreject', 'dormant',
  'projects', 'quarantine', 'capture-error', 'doctor', 'support-bundle', 'tokens', 'failures', 'snapshot',
  'session', 'handoff', 'card', 'current', 'forget', 'inspect', 'embed', 'watch', 'learn', 'promote',
  'share', 'peers', 'sync', 'import', 'export', 'capture', 'setup', 'last-sleep', 'session-end',
  'pre-compact', 'compact-resume', 'post-compact', 'codex-run', 'hook', 'predict', 'decide', 'incident',
  'process', 'policy', 'skill', 'brief', 'note', 'graph', 'invalidate', 'wm', 'dashboard', 'mcp', 'serve',
  'goal', 'auth', 'audit',
];

export function usageText(): string {
  const printed = new Map<string, number>();
  const blocks = USAGE_ORDER.map((verb) => {
    const index = printed.get(verb) ?? 0;
    printed.set(verb, index + 1);
    return COMMANDS[verb].usage[index];
  });
  return USAGE_HEADER + blocks.join('') + USAGE_EXAMPLES;
}

function printUsage(): void {
  console.log(usageText());
}

/** One verb's help blocks as `hippo <verb> --help` prints them, or null for a verb with none. */
export function verbUsage(verb: string): string | null {
  const usage = COMMAND_INDEX.get(verb)?.usage ?? [];
  return usage.length > 0 ? usage.join('').slice(1) : null;
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
    printError('--scope requires a non-empty value (e.g. --scope slack:private:C1).');
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
      printError(`--${key} requires a numeric value.`);
      process.exit(1);
    }
  }
  // Reject rather than coerce: consumers read --dry-run both as Boolean() and === true,
  // so no single coercion of an inline value would be correct for every one of them.
  for (const key of BOOLEAN_FLAGS) {
    if (Object.hasOwn(flags, key) && typeof flags[key] !== 'boolean') {
      printError(`--${key} takes no value`);
      process.exit(1);
    }
  }
  // card checks its flags per subcommand, with a stricter message.
  const unknownFlags = command === 'card' ? [] : Object.keys(flags).filter((key) => !KNOWN_FLAGS.has(key));
  if (unknownFlags.length > 0) {
    const names = unknownFlags.map((key) => `--${key}`).join(', ');
    if (DESTRUCTIVE_COMMANDS.has(command)) {
      printError(`Unknown flag ${names} for hippo ${command}. Nothing was changed.`);
      process.exit(2);
    }
    printError(`hippo: ignoring unknown flag ${names}. A later release will reject it.`);
  }
  const refusal = Object.hasOwn(flags, 'dry-run') ? dryRunRefusal(command, args, flags) : null;
  if (refusal) {
    printError(refusal);
    process.exit(2);
  }
  const spec = COMMAND_INDEX.get(command);
  if (!spec) {
    printError(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  await spec.run({ hippoRoot, args, flags });
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);
  try {
    await main(command, args, flags, getHippoRoot(process.cwd()));
  } catch (err) {
    printError('Error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// bin/hippo.js calls runCli(); this keeps `node dist/cli.js` working while an import runs nothing.
const entryPath = process.argv[1];
if (entryPath && fs.existsSync(entryPath) && fs.realpathSync(entryPath) === fileURLToPath(import.meta.url)) {
  void runCli();
}
