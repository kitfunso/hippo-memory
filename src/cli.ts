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

import { envSkipAutoIntegrations } from './env.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { repairCodexWrapperIfInstalled } from './hooks/codex-wrapper.js';
import { getHippoRoot } from './store/open.js';
import { cmdGithub, printGithubBackfillUsage } from './connectors/github/cli-impl.js';
import { printError } from './cli/output.js';
import { errorFields, errorMessage, isLevelEnabled, log } from './log.js';
import { isStoreBusy, STORE_BUSY_MESSAGE } from './db/busy.js';
import { type CliFlags, type CommandContext, boolFlag, flagIsTrue } from './cli/shared.js';
import { VERB_USAGE, USAGE_HEADER, USAGE_EXAMPLES, printAuditPruneUsage, printSlackBackfillUsage, printSlackWorkspacesUsage } from './cli/usage.js';
import { type FlagKind, type VerbFlags, VERB_FLAGS, flagKind, isKnownFlag, undeclaredFlags } from './cli/flags.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Commands that delete or hide memories: an unknown flag here stops the run instead of being ignored.
const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'audit', 'dedup', 'forget', 'invalidate', 'projects', 'reject', 'resolve', 'sleep', 'supersede',
]);

// Commands that honour --dry-run. Any other command would ignore it and run for real.
const DRY_RUN_COMMANDS: ReadonlySet<string> = new Set([
  'audit', 'capture', 'dedup', 'forget', 'import', 'invalidate', 'refine', 'setup', 'sleep',
]);

// share and brief honour --dry-run in one form only; their other forms write for real.
function dryRunRefusal(command: string, args: string[], flags: CliFlags): string | null {
  const isBrief = command === 'brief' || command === 'project-brief';
  const onlyForm = command === 'share' ? 'share --auto' : isBrief ? `${command} refresh` : null;
  const honoured = command === 'share' ? args[0] === '--auto' || boolFlag(flags, 'auto')
    : isBrief ? args[0] === 'refresh' : DRY_RUN_COMMANDS.has(command);
  if (honoured) return null;
  const where = onlyForm ? ` outside \`hippo ${onlyForm}\`` : '';
  return `hippo ${command} has no --dry-run${where}, so it would run for real. Nothing was changed.`;
}

function pushRepeatableFlag(flags: CliFlags, key: string, value: string): void {
  if (Array.isArray(flags[key])) {
    // SAFETY: Array.isArray just confirmed flags[key] is an array; the union has no other array member.
    (flags[key] as string[]).push(value);
  } else {
    flags[key] = [value];
  }
}

function setGluedFlag(flags: CliFlags, key: string, value: string, kind: FlagKind): void {
  // Glued form has no following token to swallow, so a switch gets its
  // own branch here instead of the swallow-avoidance short-circuit in setSeparatedFlag.
  if (kind === 'switch') {
    flags[key] = value;
  } else if (kind === 'list') {
    if (value !== '') pushRepeatableFlag(flags, key, value);
  } else {
    flags[key] = value === '' ? true : value;
  }
}

/** Returns how many tokens the flag consumed: its own, plus `next` when that is its value. */
function setSeparatedFlag(flags: CliFlags, key: string, next: string | undefined, kind: FlagKind): number {
  if (kind === 'switch' && (next === 'true' || next === 'false')) {
    // Kept as a value so main() rejects it, instead of `--pin true` pinning the text "... true".
    flags[key] = next;
    return 2;
  }
  if (!next || next.startsWith('--') || kind === 'switch') {
    // Boolean flag
    flags[key] = true;
    return 1;
  }
  if (kind === 'list') pushRepeatableFlag(flags, key, next);
  else flags[key] = next;
  return 2;
}

export function parseArgs(argv: string[]): { command: string; args: string[]; flags: CliFlags } {
  const [, , command = '', ...rest] = argv;
  const args: string[] = [];
  const flags: CliFlags = {};
  const declared = COMMAND_INDEX.get(command)?.flags;

  let i = 0;
  while (i < rest.length) {
    const part = rest[i];
    if (part === '--') {
      args.push(...rest.slice(i + 1));
      break;
    }
    if (part.startsWith('--')) {
      const eqIdx = part.indexOf('=');
      const key = part.slice(2, eqIdx > 2 ? eqIdx : undefined);
      if (eqIdx > 2) {
        setGluedFlag(flags, key, part.slice(eqIdx + 1), flagKind(declared, key));
        i++;
      } else {
        i += setSeparatedFlag(flags, key, rest[i + 1], flagKind(declared, key));
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

export function shouldAutoRepairCodexWrapper(currentCommand: string, flags: CliFlags): boolean {
  if (envSkipAutoIntegrations()) return false;
  if (!['context', 'remember', 'recall', 'sleep', 'capture', 'outcome', 'status', 'init'].includes(currentCommand)) {
    return false;
  }
  if (currentCommand === 'init' && flagIsTrue(flags, 'no-hooks')) return false;
  return true;
}

// Repair-only: keeps the wrapper healthy for users who opted in via `hippo
// hook install codex` (a Codex update can restore the real binary over our
// shim). Never first-installs — silently swapping the codex binary on routine
// commands is a consent violation and reads as binary hijacking to
// supply-chain scanners.
function maybeRepairCodexWrapper(currentCommand: string, flags: CliFlags): void {
  if (!shouldAutoRepairCodexWrapper(currentCommand, flags)) return;
  try {
    repairCodexWrapperIfInstalled();
  } catch (err) {
    log.debug(`codex wrapper not repaired: ${errorMessage(err)}`);
  }
}

interface CommandSpec {
  readonly run: (ctx: CommandContext) => void | Promise<void>;
  readonly aliases?: readonly string[];
  /** Runs in a request scope, opening each store once; set on api-backed verbs, as hook verbs open their own. */
  readonly scoped?: true;
  // Each block opens with a newline so the full listing is their concatenation.
  readonly usage: readonly string[];
  /** The flags this verb reads; any other flag still parses, and the verb says it ignores it. */
  readonly flags: VerbFlags;
}

/** Every verb main() dispatches, keyed by name, with its handler, aliases and help blocks. */
export const COMMANDS = {
  init: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/init.js')).cmdInit(hippoRoot, flags); },
    usage: VERB_USAGE.init,
    flags: VERB_FLAGS.init,
  },
  remember: {
    run: async (c) => { await (await import('./cli/remember.js')).handleRemember(c); },
    usage: VERB_USAGE.remember,
    flags: VERB_FLAGS.remember,
  },
  recall: {
    run: async (c) => { await (await import('./cli/recall.js')).handleRecall(c); },
    scoped: true,
    usage: VERB_USAGE.recall,
    flags: VERB_FLAGS.recall,
  },
  drill: {
    run: async (c) => { await (await import('./cli/dag.js')).handleDrill(c); },
    scoped: true,
    usage: VERB_USAGE.drill,
    flags: VERB_FLAGS.drill,
  },
  assemble: {
    run: async (c) => { await (await import('./cli/dag.js')).handleAssemble(c); },
    scoped: true,
    usage: VERB_USAGE.assemble,
    flags: VERB_FLAGS.assemble,
  },
  supersede: {
    run: async (c) => { await (await import('./cli/remember.js')).handleSupersede(c); },
    usage: VERB_USAGE.supersede,
    flags: VERB_FLAGS.supersede,
  },
  explain: {
    run: async (c) => { await (await import('./cli/explain.js')).handleExplain(c); },
    scoped: true,
    usage: VERB_USAGE.explain,
    flags: VERB_FLAGS.explain,
  },
  eval: {
    run: async (c) => { await (await import('./cli/eval.js')).handleEval(c); },
    usage: VERB_USAGE.eval,
    flags: VERB_FLAGS.eval,
  },
  trace: {
    run: async (c) => { await (await import('./cli/remember.js')).handleTrace(c); },
    usage: VERB_USAGE.trace,
    flags: VERB_FLAGS.trace,
  },
  refine: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/maintenance.js')).cmdRefine(hippoRoot, flags); },
    usage: VERB_USAGE.refine,
    flags: VERB_FLAGS.refine,
  },
  sleep: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/sleep.js')).cmdSleep(hippoRoot, flags); },
    scoped: true,
    usage: VERB_USAGE.sleep,
    flags: VERB_FLAGS.sleep,
  },
  'last-sleep': {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/last-sleep.js')).cmdLastSleep(hippoRoot, flags); },
    usage: VERB_USAGE['last-sleep'],
    flags: VERB_FLAGS['last-sleep'],
  },
  'session-end': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdSessionEnd(hippoRoot, flags); },
    usage: VERB_USAGE['session-end'],
    flags: VERB_FLAGS['session-end'],
  },
  '__session-end-worker': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdSessionEndWorker(hippoRoot, flags); },
    usage: [],
    flags: VERB_FLAGS['__session-end-worker'],
  },
  'pre-compact': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handlePreCompact(c); },
    usage: VERB_USAGE['pre-compact'],
    flags: VERB_FLAGS['pre-compact'],
  },
  'post-compact': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handlePostCompact(c); },
    usage: VERB_USAGE['post-compact'],
    flags: VERB_FLAGS['post-compact'],
  },
  'capture-error': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCaptureError(c); },
    usage: VERB_USAGE['capture-error'],
    flags: VERB_FLAGS['capture-error'],
  },
  'compact-resume': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCompactResume(c); },
    usage: VERB_USAGE['compact-resume'],
    flags: VERB_FLAGS['compact-resume'],
  },
  'codex-run': {
    run: async ({ hippoRoot, args }) => { (await import('./cli/session-hooks.js')).cmdCodexRun(hippoRoot, args); },
    usage: VERB_USAGE['codex-run'],
    flags: VERB_FLAGS['codex-run'],
  },
  '__codex-session-end-worker': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdCodexSessionEndWorker(hippoRoot, flags); },
    usage: [],
    flags: VERB_FLAGS['__codex-session-end-worker'],
  },
  dedup: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/maintenance.js')).cmdDedup(hippoRoot, flags); },
    usage: VERB_USAGE.dedup,
    flags: VERB_FLAGS.dedup,
  },
  dag: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/dag.js')).cmdDag(hippoRoot, flags); },
    usage: VERB_USAGE.dag,
    flags: VERB_FLAGS.dag,
  },
  auth: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/auth.js')).cmdAuth(hippoRoot, args, flags); },
    scoped: true,
    usage: VERB_USAGE.auth,
    flags: VERB_FLAGS.auth,
  },
  goal: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/goals.js')).cmdGoal(hippoRoot, args, flags); },
    scoped: true,
    usage: VERB_USAGE.goal,
    flags: VERB_FLAGS.goal,
  },
  slack: {
    run: async ({ hippoRoot, args, flags }) => { await (await import('./cli/slack.js')).cmdSlack(hippoRoot, args, flags); },
    usage: VERB_USAGE.slack,
    flags: VERB_FLAGS.slack,
  },
  github: {
    run: async ({ hippoRoot, args, flags }) => { await cmdGithub(hippoRoot, args, flags); },
    usage: VERB_USAGE.github,
    flags: VERB_FLAGS.github,
  },
  audit: {
    run: async (c) => { await (await import('./cli/audit.js')).handleAudit(c); },
    scoped: true,
    usage: VERB_USAGE.audit,
    flags: VERB_FLAGS.audit,
  },
  'correction-latency': {
    run: async (c) => { await (await import('./cli/status.js')).handleCorrectionLatency(c); },
    usage: VERB_USAGE['correction-latency'],
    flags: VERB_FLAGS['correction-latency'],
  },
  provenance: {
    run: async (c) => { await (await import('./cli/status.js')).handleProvenance(c); },
    usage: VERB_USAGE.provenance,
    flags: VERB_FLAGS.provenance,
  },
  status: {
    run: async ({ hippoRoot }) => { (await import('./cli/status.js')).cmdStatus(hippoRoot); },
    usage: VERB_USAGE.status,
    flags: VERB_FLAGS.status,
  },
  outcome: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdOutcome(hippoRoot, flags); },
    scoped: true,
    usage: VERB_USAGE.outcome,
    flags: VERB_FLAGS.outcome,
  },
  conflicts: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdConflicts(hippoRoot, flags); },
    usage: VERB_USAGE.conflicts,
    flags: VERB_FLAGS.conflicts,
  },
  resolve: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdResolve(hippoRoot, args, flags); },
    usage: VERB_USAGE.resolve,
    flags: VERB_FLAGS.resolve,
  },
  reject: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdReject(hippoRoot, args, flags); },
    usage: VERB_USAGE.reject,
    flags: VERB_FLAGS.reject,
  },
  rejections: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdRejections(hippoRoot, flags); },
    usage: VERB_USAGE.rejections,
    flags: VERB_FLAGS.rejections,
  },
  unreject: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdUnreject(hippoRoot, args, flags); },
    usage: VERB_USAGE.unreject,
    flags: VERB_FLAGS.unreject,
  },
  dormant: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdDormant(hippoRoot, args, flags); },
    scoped: true,
    usage: VERB_USAGE.dormant,
    flags: VERB_FLAGS.dormant,
  },
  projects: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/projects.js')).cmdProjects(hippoRoot, args, flags); },
    usage: VERB_USAGE.projects,
    flags: VERB_FLAGS.projects,
  },
  quarantine: {
    run: async ({ hippoRoot, args, flags }) => { await (await import('./cli/curate.js')).cmdQuarantine(hippoRoot, args, flags); },
    scoped: true,
    usage: VERB_USAGE.quarantine,
    flags: VERB_FLAGS.quarantine,
  },
  tokens: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/status.js')).cmdTokens(hippoRoot, flags); },
    scoped: true,
    usage: VERB_USAGE.tokens,
    flags: VERB_FLAGS.tokens,
  },
  failures: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/status.js')).cmdFailures(hippoRoot, flags); },
    scoped: true,
    usage: VERB_USAGE.failures,
    flags: VERB_FLAGS.failures,
  },
  doctor: {
    run: async (c) => { await (await import('./cli/status.js')).handleDoctor(c); },
    usage: VERB_USAGE.doctor,
    flags: VERB_FLAGS.doctor,
  },
  'support-bundle': {
    run: async (c) => { await (await import('./cli/status.js')).handleSupportBundle(c); },
    usage: VERB_USAGE['support-bundle'],
    flags: VERB_FLAGS['support-bundle'],
  },
  snapshot: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdSnapshot(hippoRoot, args, flags); },
    usage: VERB_USAGE.snapshot,
    flags: VERB_FLAGS.snapshot,
  },
  session: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdSession(hippoRoot, args, flags); },
    usage: VERB_USAGE.session,
    flags: VERB_FLAGS.session,
  },
  handoff: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdHandoff(hippoRoot, args, flags); },
    usage: VERB_USAGE.handoff,
    flags: VERB_FLAGS.handoff,
  },
  card: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/card.js')).cmdCard(hippoRoot, args, flags); },
    usage: VERB_USAGE.card,
    flags: VERB_FLAGS.card,
  },
  predict: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdPredict(hippoRoot, args, flags); },
    usage: VERB_USAGE.predict,
    flags: VERB_FLAGS.predict,
  },
  current: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdCurrent(hippoRoot, args, flags); },
    usage: VERB_USAGE.current,
    flags: VERB_FLAGS.current,
  },
  forget: {
    run: async (c) => { await (await import('./cli/curate.js')).handleForget(c); },
    scoped: true,
    usage: VERB_USAGE.forget,
    flags: VERB_FLAGS.forget,
  },
  inspect: {
    run: async (c) => { await (await import('./cli/status.js')).handleInspect(c); },
    usage: VERB_USAGE.inspect,
    flags: VERB_FLAGS.inspect,
  },
  context: {
    run: async (c) => { await (await import('./cli/context.js')).handleContext(c); },
    usage: VERB_USAGE.context,
    flags: VERB_FLAGS.context,
  },
  hook: {
    run: async ({ args }) => { (await import('./cli/setup.js')).cmdHook(args); },
    usage: VERB_USAGE.hook,
    flags: VERB_FLAGS.hook,
  },
  setup: {
    run: async ({ flags }) => { (await import('./cli/setup.js')).cmdSetup(flags); },
    usage: VERB_USAGE.setup,
    flags: VERB_FLAGS.setup,
  },
  'daily-runner': {
    run: async () => { (await import('./cli/setup.js')).cmdDailyRunner(); },
    usage: VERB_USAGE['daily-runner'],
    flags: VERB_FLAGS['daily-runner'],
  },
  embed: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/maintenance.js')).cmdEmbed(hippoRoot, flags); },
    usage: VERB_USAGE.embed,
    flags: VERB_FLAGS.embed,
  },
  watch: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleWatch(c); },
    usage: VERB_USAGE.watch,
    flags: VERB_FLAGS.watch,
  },
  learn: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/transfer.js')).cmdLearn(hippoRoot, flags); },
    scoped: true,
    usage: VERB_USAGE.learn,
    flags: VERB_FLAGS.learn,
  },
  promote: {
    run: async (c) => { await (await import('./cli/transfer.js')).handlePromote(c); },
    scoped: true,
    usage: VERB_USAGE.promote,
    flags: VERB_FLAGS.promote,
  },
  sync: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/transfer.js')).cmdSync(hippoRoot, flags); },
    usage: VERB_USAGE.sync,
    flags: VERB_FLAGS.sync,
  },
  share: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleShare(c); },
    usage: VERB_USAGE.share,
    flags: VERB_FLAGS.share,
  },
  peers: {
    run: async (c) => { await (await import('./cli/transfer.js')).handlePeers(c); },
    usage: VERB_USAGE.peers,
    flags: VERB_FLAGS.peers,
  },
  import: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/transfer.js')).cmdImport(hippoRoot, args, flags); },
    usage: VERB_USAGE.import,
    flags: VERB_FLAGS.import,
  },
  export: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleExport(c); },
    usage: VERB_USAGE.export,
    flags: VERB_FLAGS.export,
  },
  capture: {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCapture(c); },
    usage: VERB_USAGE.capture,
    flags: VERB_FLAGS.capture,
  },
  dashboard: {
    run: async (c) => { await (await import('./cli/serve.js')).handleDashboard(c); },
    usage: VERB_USAGE.dashboard,
    flags: VERB_FLAGS.dashboard,
  },
  wm: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdWm(hippoRoot, args, flags); },
    usage: VERB_USAGE.wm,
    flags: VERB_FLAGS.wm,
  },
  mcp: {
    run: async () => { await (await import('./cli/serve.js')).handleMcp(); },
    usage: VERB_USAGE.mcp,
    flags: VERB_FLAGS.mcp,
  },
  serve: {
    run: async (c) => { await (await import('./cli/serve.js')).handleServe(c); },
    usage: VERB_USAGE.serve,
    flags: VERB_FLAGS.serve,
  },
  invalidate: {
    run: async (c) => { await (await import('./cli/curate.js')).handleInvalidate(c); },
    usage: VERB_USAGE.invalidate,
    flags: VERB_FLAGS.invalidate,
  },
  decide: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdDecide(hippoRoot, args, flags); },
    usage: VERB_USAGE.decide,
    flags: VERB_FLAGS.decide,
  },
  incident: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdIncident(hippoRoot, args, flags); },
    usage: VERB_USAGE.incident,
    flags: VERB_FLAGS.incident,
  },
  process: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdProcess(hippoRoot, args, flags); },
    usage: VERB_USAGE.process,
    flags: VERB_FLAGS.process,
  },
  policy: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdPolicy(hippoRoot, args, flags); },
    usage: VERB_USAGE.policy,
    flags: VERB_FLAGS.policy,
  },
  skill: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdSkill(hippoRoot, args, flags); },
    usage: VERB_USAGE.skill,
    flags: VERB_FLAGS.skill,
  },
  brief: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdProjectBrief(hippoRoot, args, flags); },
    aliases: ['project-brief'],
    usage: VERB_USAGE.brief,
    flags: VERB_FLAGS.brief,
  },
  note: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdCustomerNote(hippoRoot, args, flags); },
    aliases: ['customer-note'],
    usage: VERB_USAGE.note,
    flags: VERB_FLAGS.note,
  },
  graph: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdGraph(hippoRoot, args, flags); },
    usage: VERB_USAGE.graph,
    flags: VERB_FLAGS.graph,
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

function printVersion(): never {
  const __filename_local = fileURLToPath(import.meta.url);
  const __dirname_local = path.dirname(__filename_local);
  const pkgJson = fs.readFileSync(path.join(__dirname_local, '..', 'package.json'), 'utf-8');
  const { version } = JSON.parse(pkgJson) as { version: string };
  console.log(version);
  process.exit(0);
}

/** A value-less --scope parses as boolean true, which consumers coerced to the scope 'true' or dropped;
 *  reject it once here so every command, thin-client relays included, sees only a non-empty string. */
function rejectEmptyScope(flags: CliFlags): void {
  if ('scope' in flags && (typeof flags['scope'] !== 'string' || !flags['scope'].trim())) {
    printError('--scope requires a non-empty value (e.g. --scope slack:private:C1).');
    process.exit(1);
  }
}

// parseArgs stores a value-less flag as boolean true, and NaN then survives every
// downstream guard because each comparison against it is false.
function rejectNonNumericFlags(flags: CliFlags, declared: VerbFlags | undefined): void {
  for (const [key, raw] of Object.entries(flags)) {
    if (flagKind(declared, key) !== 'number') continue;
    if (typeof raw !== 'string' || !raw.trim() || !Number.isFinite(Number(raw))) {
      printError(`--${key} requires a numeric value.`);
      process.exit(1);
    }
  }
}

// Reject rather than coerce: consumers read --dry-run both as Boolean() and === true,
// so no single coercion of an inline value would be correct for every one of them.
function rejectValuedSwitches(flags: CliFlags, declared: VerbFlags | undefined): void {
  for (const [key, raw] of Object.entries(flags)) {
    if (flagKind(declared, key) === 'switch' && typeof raw !== 'boolean') {
      printError(`--${key} takes no value`);
      process.exit(1);
    }
  }
}

function checkUnknownFlags(command: string, flags: CliFlags, declared: VerbFlags | undefined): void {
  // card checks its flags per subcommand, with a stricter message.
  if (command === 'card') return;
  const flagNames = (keys: readonly string[]): string => keys.map((key) => `--${key}`).join(', ');
  const unknown = Object.keys(flags).filter((key) => !isKnownFlag(key));
  if (unknown.length > 0 && DESTRUCTIVE_COMMANDS.has(command)) {
    printError(`Unknown flag ${flagNames(unknown)} for hippo ${command}. Nothing was changed.`);
    process.exit(2);
  }
  // main() refuses --dry-run by name on a verb without one, so that flag is not also called ignored.
  const ignored = declared ? undeclaredFlags(declared, Object.keys(flags)).filter((key) => key !== 'dry-run') : unknown;
  if (ignored.length > 0) printError(`hippo: ignoring unknown flag ${flagNames(ignored)}. A later release will reject it.`);
}

async function main(
  command: string,
  args: string[],
  flags: CliFlags,
  hippoRoot: string,
): Promise<void> {
  if (command === '--version' || command === '-v' || flags['version']) printVersion();
  if (command === '' || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }
  // Before every other step, so help never opens a store, installs a hook or starts a server.
  if (Object.hasOwn(flags, 'help')) {
    printHelp(command, args);
    return;
  }
  const spec = COMMAND_INDEX.get(command);
  maybeRepairCodexWrapper(command, flags);
  rejectEmptyScope(flags);
  rejectNonNumericFlags(flags, spec?.flags);
  rejectValuedSwitches(flags, spec?.flags);
  checkUnknownFlags(command, flags, spec?.flags);
  const refusal = Object.hasOwn(flags, 'dry-run') ? dryRunRefusal(command, args, flags) : null;
  if (refusal) {
    printError(refusal);
    process.exit(2);
  }
  if (!spec) {
    printError(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  const run = (): void | Promise<void> => spec.run({ hippoRoot, args, flags });
  await (spec.scoped ? (await import('./db/request-stores.js')).runWithRequestStores(run) : run());
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);
  try {
    await main(command, args, flags, getHippoRoot(process.cwd()));
  } catch (err) {
    printError('Error:', isStoreBusy(err) ? STORE_BUSY_MESSAGE : err instanceof Error ? err.message : err);
    // The message alone rarely says where it came from; debug is the level that asks for the rest.
    if (isLevelEnabled('debug')) {
      const { errorClass, stack } = errorFields(err);
      printError(`  thrown as ${errorClass}${stack ? `\n${stack}` : ''}`);
    }
    process.exit(1);
  }
}

// bin/hippo.js calls runCli(); this keeps `node dist/cli.js` working while an import runs nothing.
const entryPath = process.argv[1];
if (entryPath && fs.existsSync(entryPath) && fs.realpathSync(entryPath) === fileURLToPath(import.meta.url)) {
  void runCli();
}
