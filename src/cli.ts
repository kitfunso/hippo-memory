#!/usr/bin/env node
// Hippo CLI entry point: parses argv and dispatches each verb through the table in cli/verbs.ts.
// `hippo help` prints the verb list from that table, so no list is kept here.

import { envSkipAutoIntegrations } from './util/env.js';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { repairCodexWrapperIfInstalled } from './hooks/codex-wrapper.js';
import { getHippoRoot } from './core/project-identity.js';
import { resolveTenantId } from './store/tenant.js';
import { printGitHubBackfillUsage } from './cli/github.js';
import { printError } from './cli/output.js';
import { errorFields, errorMessage, isLevelEnabled, log } from './util/log.js';
import { isStoreBusy, STORE_BUSY_MESSAGE } from './db/busy.js';
import { type CliFlags, flagIsTrue, isBooleanFlag, isStringFlag } from './cli/flag-values.js';
import { USAGE_HEADER, USAGE_EXAMPLES, printAuditPruneUsage, printSlackBackfillUsage, printSlackWorkspacesUsage } from './cli/usage.js';
import { type FlagKind, type VerbFlags, flagKind, isKnownFlag, undeclaredFlags } from './cli/flags.js';
import { COMMANDS } from './cli/verbs.js';
import type { VerbSpec } from './cli/verb-row.js';
import { CliExit } from './cli/exit.js';

// Helpers

// Commands that delete or hide memories: an unknown flag here stops the run instead of being ignored.
const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'audit', 'dedup', 'forget', 'invalidate', 'projects', 'reject', 'resolve', 'sleep', 'supersede',
]);

// A command that does not honour --dry-run would ignore it and run for real.
function dryRunRefusal(command: string, spec: VerbSpec | undefined, args: string[], flags: CliFlags): string | null {
  const only = spec?.dryRun;
  const honoured = only === undefined ? spec?.flags.switches?.includes('dry-run') : only !== false && only.honoured(args, flags);
  if (honoured) return null;
  const where = only ? ` outside \`hippo ${command} ${only.form}\`` : '';
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

export function parseArgs(argv: string[]) {
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

// Repair-only: never first-installs, because silently swapping the codex binary on routine commands
// is a consent violation and reads as binary hijacking to supply-chain scanners.
function maybeRepairCodexWrapper(currentCommand: string, flags: CliFlags): void {
  if (!shouldAutoRepairCodexWrapper(currentCommand, flags)) return;
  try {
    repairCodexWrapperIfInstalled();
  } catch (err) {
    log.debug(`codex wrapper not repaired: ${errorMessage(err)}`);
  }
}

const ROWS: readonly VerbSpec[] = Object.values(COMMANDS);

const COMMAND_INDEX: ReadonlyMap<string, VerbSpec> = new Map(
  Object.entries<VerbSpec>(COMMANDS).flatMap(([verb, spec]) =>
    [verb, ...(spec.aliases ?? [])].map((name): [string, VerbSpec] => [name, spec])),
);

export function usageText(): string {
  const blocks = [...ROWS.flatMap((row) => row.usage ?? []), ...ROWS.flatMap((row) => row.listedLast ?? [])];
  return USAGE_HEADER + blocks.join('') + USAGE_EXAMPLES;
}

function printUsage(): void {
  console.log(usageText());
}

/** One verb's help blocks as `hippo <verb> --help` prints them, or null for a verb with none. */
export function verbUsage(verb: string): string | null {
  const spec = COMMAND_INDEX.get(verb);
  const usage = [...(spec?.usage ?? []), ...(spec?.listedLast ?? [])];
  return usage.length > 0 ? usage.join('').slice(1) : null;
}

// These sub-commands have fuller usage text than their lines in usageText().
const SUBCOMMAND_USAGE: ReadonlyMap<string, () => void> = new Map([
  ['audit prune', printAuditPruneUsage],
  ['slack backfill', printSlackBackfillUsage],
  ['slack workspaces', printSlackWorkspacesUsage],
  ['github backfill', printGitHubBackfillUsage],
]);

function printHelp(command: string, args: string[]): void {
  const printSubcommandUsage = SUBCOMMAND_USAGE.get(`${command} ${args[0] ?? ''}`);
  if (printSubcommandUsage) printSubcommandUsage();
  else console.log(verbUsage(command) ?? usageText());
}

// Entry point

function printVersion(): never {
  const __filename_local = fileURLToPath(import.meta.url);
  const __dirname_local = path.dirname(__filename_local);
  const pkgJson = fs.readFileSync(path.join(__dirname_local, '..', 'package.json'), 'utf-8');
  // SAFETY: package.json ships with the build, and npm refuses to pack a package without a string version.
  const { version } = JSON.parse(pkgJson) as { version: string };
  console.log(version);
  throw new CliExit(0);
}

/** A value-less --scope parses as boolean true, which consumers coerced to the scope 'true' or dropped;
 *  reject it once here so every command, thin-client relays included, sees only a non-empty string. */
function rejectEmptyScope(flags: CliFlags): void {
  if ('scope' in flags && (!isStringFlag(flags['scope']) || !flags['scope'].trim())) {
    printError('--scope requires a non-empty value (e.g. --scope slack:private:C1).');
    throw new CliExit(1);
  }
}

// parseArgs stores a value-less flag as boolean true, and NaN then survives every
// downstream guard because each comparison against it is false.
function rejectNonNumericFlags(flags: CliFlags, declared: VerbFlags | undefined): void {
  for (const [key, raw] of Object.entries(flags)) {
    if (flagKind(declared, key) !== 'number') continue;
    if (!isStringFlag(raw) || !raw.trim() || !Number.isFinite(Number(raw))) {
      printError(`--${key} requires a numeric value.`);
      throw new CliExit(1);
    }
  }
}

// Reject rather than coerce: consumers read --dry-run both as Boolean() and === true,
// so no single coercion of an inline value would be correct for every one of them.
function rejectValuedSwitches(flags: CliFlags, declared: VerbFlags | undefined): void {
  for (const [key, raw] of Object.entries(flags)) {
    if (flagKind(declared, key) === 'switch' && !isBooleanFlag(raw)) {
      printError(`--${key} takes no value`);
      throw new CliExit(1);
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
    throw new CliExit(2);
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
  const refusal = Object.hasOwn(flags, 'dry-run') ? dryRunRefusal(command, spec, args, flags) : null;
  if (refusal) {
    printError(refusal);
    throw new CliExit(2);
  }
  if (!spec) {
    printError(`Unknown command: ${command}`);
    printUsage();
    throw new CliExit(1);
  }
  const run = (): void | Promise<void> => spec.run({ hippoRoot, tenantId: resolveTenantId({}), args, flags });
  await (spec.scoped ? (await import('./db/request-stores.js')).runWithRequestStores(run) : run());
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);
  try {
    await main(command, args, flags, getHippoRoot(process.cwd()));
  } catch (err) {
    // The verb printed its own message before it threw, so this branch adds no line.
    if (err instanceof CliExit) process.exit(err.code);
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
