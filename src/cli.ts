#!/usr/bin/env node
// Hippo CLI entry point: parses argv and dispatches each verb through the table below.
// `hippo help` prints the verb list from that table, so no list is kept here.

import { envSkipAutoIntegrations } from './util/env.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { repairCodexWrapperIfInstalled } from './hooks/codex-wrapper.js';
import { getHippoRoot } from './store/open.js';
import { cmdGithub, printGithubBackfillUsage } from './connectors/github/cli-impl.js';
import { printError } from './cli/output.js';
import { errorFields, errorMessage, isLevelEnabled, log } from './util/log.js';
import { isStoreBusy, STORE_BUSY_MESSAGE } from './db/busy.js';
import { type CliFlags, type CommandContext, boolFlag, flagIsTrue } from './cli/flag-values.js';
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

/** What a verb's row states; its help blocks and flags are looked up by the row's key. */
interface VerbHandler {
  readonly run: (ctx: CommandContext) => void | Promise<void>;
  readonly aliases?: readonly string[];
  /** Runs in a request scope, opening each store once; set on api-backed verbs, as hook verbs open their own. */
  readonly scoped?: true;
}

interface CommandSpec extends VerbHandler {
  // Each block opens with a newline so the full listing is their concatenation.
  readonly usage: readonly string[];
  /** The flags this verb reads; any other flag still parses, and the verb says it ignores it. */
  readonly flags: VerbFlags;
}

type VerbName = keyof typeof VERB_FLAGS;

/** Every verb main() dispatches, keyed by name; a verb without a VERB_FLAGS entry, or the reverse, fails to compile. */
export const VERB_HANDLERS = {
  init: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/init.js')).cmdInit(hippoRoot, flags); },
  },
  remember: {
    run: async (c) => { await (await import('./cli/remember.js')).handleRemember(c); },
  },
  recall: {
    run: async (c) => { await (await import('./cli/recall.js')).handleRecall(c); },
    scoped: true,
  },
  drill: {
    run: async (c) => { await (await import('./cli/dag.js')).handleDrill(c); },
    scoped: true,
  },
  assemble: {
    run: async (c) => { await (await import('./cli/dag.js')).handleAssemble(c); },
    scoped: true,
  },
  supersede: {
    run: async (c) => { await (await import('./cli/remember.js')).handleSupersede(c); },
  },
  explain: {
    run: async (c) => { await (await import('./cli/explain.js')).handleExplain(c); },
    scoped: true,
  },
  eval: {
    run: async (c) => { await (await import('./cli/eval.js')).handleEval(c); },
  },
  trace: {
    run: async (c) => { await (await import('./cli/remember.js')).handleTrace(c); },
  },
  refine: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/maintenance.js')).cmdRefine(hippoRoot, flags); },
  },
  sleep: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/sleep.js')).cmdSleep(hippoRoot, flags); },
    scoped: true,
  },
  'last-sleep': {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/last-sleep.js')).cmdLastSleep(hippoRoot, flags); },
  },
  'session-end': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdSessionEnd(hippoRoot, flags); },
  },
  '__session-end-worker': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdSessionEndWorker(hippoRoot, flags); },
  },
  'pre-compact': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handlePreCompact(c); },
  },
  'post-compact': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handlePostCompact(c); },
  },
  'capture-error': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCaptureError(c); },
  },
  'compact-resume': {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCompactResume(c); },
  },
  'codex-run': {
    run: async ({ hippoRoot, args }) => { (await import('./cli/session-hooks.js')).cmdCodexRun(hippoRoot, args); },
  },
  '__codex-session-end-worker': {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/session-hooks.js')).cmdCodexSessionEndWorker(hippoRoot, flags); },
  },
  dedup: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/maintenance.js')).cmdDedup(hippoRoot, flags); },
  },
  dag: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/dag.js')).cmdDag(hippoRoot, flags); },
  },
  auth: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/auth.js')).cmdAuth(hippoRoot, args, flags); },
    scoped: true,
  },
  goal: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/goals.js')).cmdGoal(hippoRoot, args, flags); },
    scoped: true,
  },
  slack: {
    run: async ({ hippoRoot, args, flags }) => { await (await import('./cli/slack.js')).cmdSlack(hippoRoot, args, flags); },
  },
  github: {
    run: async ({ hippoRoot, args, flags }) => { await cmdGithub(hippoRoot, args, flags); },
  },
  audit: {
    run: async (c) => { await (await import('./cli/audit.js')).handleAudit(c); },
    scoped: true,
  },
  'correction-latency': {
    run: async (c) => { await (await import('./cli/status.js')).handleCorrectionLatency(c); },
  },
  provenance: {
    run: async (c) => { await (await import('./cli/status.js')).handleProvenance(c); },
  },
  status: {
    run: async ({ hippoRoot }) => { (await import('./cli/status.js')).cmdStatus(hippoRoot); },
  },
  outcome: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdOutcome(hippoRoot, flags); },
    scoped: true,
  },
  conflicts: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdConflicts(hippoRoot, flags); },
  },
  resolve: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdResolve(hippoRoot, args, flags); },
  },
  reject: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdReject(hippoRoot, args, flags); },
  },
  rejections: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/curate.js')).cmdRejections(hippoRoot, flags); },
  },
  unreject: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdUnreject(hippoRoot, args, flags); },
  },
  dormant: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/curate.js')).cmdDormant(hippoRoot, args, flags); },
    scoped: true,
  },
  projects: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/projects.js')).cmdProjects(hippoRoot, args, flags); },
  },
  quarantine: {
    run: async ({ hippoRoot, args, flags }) => { await (await import('./cli/curate.js')).cmdQuarantine(hippoRoot, args, flags); },
    scoped: true,
  },
  tokens: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/status.js')).cmdTokens(hippoRoot, flags); },
    scoped: true,
  },
  failures: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/status.js')).cmdFailures(hippoRoot, flags); },
    scoped: true,
  },
  doctor: {
    run: async (c) => { await (await import('./cli/status.js')).handleDoctor(c); },
  },
  'support-bundle': {
    run: async (c) => { await (await import('./cli/status.js')).handleSupportBundle(c); },
  },
  snapshot: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdSnapshot(hippoRoot, args, flags); },
  },
  session: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdSession(hippoRoot, args, flags); },
  },
  handoff: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdHandoff(hippoRoot, args, flags); },
  },
  card: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/card.js')).cmdCard(hippoRoot, args, flags); },
  },
  predict: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdPredict(hippoRoot, args, flags); },
  },
  current: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdCurrent(hippoRoot, args, flags); },
  },
  forget: {
    run: async (c) => { await (await import('./cli/curate.js')).handleForget(c); },
    scoped: true,
  },
  inspect: {
    run: async (c) => { await (await import('./cli/status.js')).handleInspect(c); },
  },
  context: {
    run: async (c) => { await (await import('./cli/context.js')).handleContext(c); },
  },
  hook: {
    run: async ({ args }) => { (await import('./cli/setup.js')).cmdHook(args); },
  },
  setup: {
    run: async ({ flags }) => { (await import('./cli/setup.js')).cmdSetup(flags); },
  },
  'daily-runner': {
    run: async () => { (await import('./cli/setup.js')).cmdDailyRunner(); },
  },
  embed: {
    run: async ({ hippoRoot, flags }) => { await (await import('./cli/maintenance.js')).cmdEmbed(hippoRoot, flags); },
  },
  watch: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleWatch(c); },
  },
  learn: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/transfer.js')).cmdLearn(hippoRoot, flags); },
    scoped: true,
  },
  promote: {
    run: async (c) => { await (await import('./cli/transfer.js')).handlePromote(c); },
    scoped: true,
  },
  sync: {
    run: async ({ hippoRoot, flags }) => { (await import('./cli/transfer.js')).cmdSync(hippoRoot, flags); },
  },
  share: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleShare(c); },
  },
  peers: {
    run: async (c) => { await (await import('./cli/transfer.js')).handlePeers(c); },
  },
  import: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/transfer.js')).cmdImport(hippoRoot, args, flags); },
  },
  export: {
    run: async (c) => { await (await import('./cli/transfer.js')).handleExport(c); },
  },
  capture: {
    run: async (c) => { await (await import('./cli/session-hooks.js')).handleCapture(c); },
  },
  dashboard: {
    run: async (c) => { await (await import('./cli/serve.js')).handleDashboard(c); },
  },
  wm: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/continuity.js')).cmdWm(hippoRoot, args, flags); },
  },
  mcp: {
    run: async () => { await (await import('./cli/serve.js')).handleMcp(); },
  },
  serve: {
    run: async (c) => { await (await import('./cli/serve.js')).handleServe(c); },
  },
  invalidate: {
    run: async (c) => { await (await import('./cli/curate.js')).handleInvalidate(c); },
  },
  decide: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdDecide(hippoRoot, args, flags); },
  },
  incident: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/decisions.js')).cmdIncident(hippoRoot, args, flags); },
  },
  process: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdProcess(hippoRoot, args, flags); },
  },
  policy: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdPolicy(hippoRoot, args, flags); },
  },
  skill: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/playbooks.js')).cmdSkill(hippoRoot, args, flags); },
  },
  brief: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdProjectBrief(hippoRoot, args, flags); },
    aliases: ['project-brief'],
  },
  note: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdCustomerNote(hippoRoot, args, flags); },
    aliases: ['customer-note'],
  },
  graph: {
    run: async ({ hippoRoot, args, flags }) => { (await import('./cli/briefs.js')).cmdGraph(hippoRoot, args, flags); },
  },
} satisfies Record<VerbName, VerbHandler>;

const USAGE_BLOCKS: Readonly<Record<string, readonly string[]>> = VERB_USAGE;
const FLAGS_BY_VERB: Readonly<Record<string, VerbFlags>> = VERB_FLAGS;

function buildCommands(): Readonly<Record<VerbName, CommandSpec>> {
  const specs = Object.entries<VerbHandler>(VERB_HANDLERS).map(([verb, handler]) => {
    const spec: CommandSpec = { ...handler, usage: USAGE_BLOCKS[verb] ?? [], flags: FLAGS_BY_VERB[verb] };
    return [verb, spec] as const;
  });
  // SAFETY: VERB_HANDLERS is checked above to have exactly the VerbName keys, so every key is present.
  return Object.fromEntries(specs) as Record<VerbName, CommandSpec>;
}

/** Every verb's handler, aliases, help blocks and flags, keyed by name. */
export const COMMANDS = buildCommands();

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
