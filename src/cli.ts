#!/usr/bin/env node

import { envReadOnly, envSkipAutoIntegrations, envTenant, validateFlags } from './base/util/env.js';
import { READ_ONLY_REFUSAL } from './base/errors/read-only.js';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { repairCodexWrapperIfInstalled } from './surface/hooks-install/codex-wrapper.js';
import { getHippoRoot } from './host/project-identity.js';
import { readPackageVersion } from './host/package-version.js';
import { printGitHubBackfillUsage } from './surface/cli/github.js';
import { printError } from './surface/cli/output.js';
import { errorFields, errorMessage, isLevelEnabled, log } from './base/util/log.js';
import { isStoreBusy, STORE_BUSY_MESSAGE } from './base/ports/store.js';
import { type CliFlags, boolFlag, isBooleanFlag, isStringFlag } from './surface/cli/flag-values.js';
import {
  USAGE_HEADER,
  USAGE_EXAMPLES,
  printAuditPruneUsage,
  printSlackBackfillUsage,
  printSlackWorkspacesUsage,
} from './surface/cli/usage.js';
import {
  type FlagKind,
  type VerbFlags,
  flagKind,
  isKnownFlag,
  undeclaredFlags,
} from './surface/cli/flags.js';
import { assertVerbPorted, CLI_STORE, COMMANDS } from './surface/cli/verbs.js';
import type { VerbSpec } from './surface/cli/verb-row.js';
import { CliExit, fail } from './surface/cli/exit.js';
import { runCliCommand } from './surface/cli/cli-runtime.js';

function dryRunRefusal(
  command: string,
  spec: VerbSpec | undefined,
  args: string[],
  flags: CliFlags,
): string | null {
  const only = spec?.dryRun;
  const honoured =
    only === undefined
      ? spec?.flags.switches?.includes('dry-run')
      : only !== false && only.honoured(args, flags);
  if (honoured) return null;
  const where = only ? ` outside \`hippo ${command} ${only.form}\`` : '';
  return `hippo ${command} has no --dry-run${where}, so it would run for real. Nothing was changed.`;
}

function pushRepeatableFlag(flags: CliFlags, key: string, value: string): void {
  if (Array.isArray(flags[key])) {
    // SAFETY: Array.isArray just confirmed flags[key] is an array; the union has no other array
    // member.
    (flags[key] as string[]).push(value);
  } else {
    flags[key] = [value];
  }
}

function setGluedFlag(flags: CliFlags, key: string, value: string, kind: FlagKind): void {
  if (kind === 'switch') {
    flags[key] = value;
  } else if (kind === 'list') {
    if (value !== '') pushRepeatableFlag(flags, key, value);
  } else {
    flags[key] = value === '' ? true : value;
  }
}

function setSeparatedFlag(
  flags: CliFlags,
  key: string,
  next: string | undefined,
  kind: FlagKind,
): number {
  if (kind === 'switch' && (next === 'true' || next === 'false')) {
    flags[key] = next;
    return 2;
  }
  if (!next || next.startsWith('--') || kind === 'switch') {
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
  if (!COMMAND_INDEX.get(currentCommand)?.repairsCodexWrapper) return false;
  if (currentCommand === 'init' && boolFlag(flags, 'no-hooks')) return false;
  return true;
}

function maybeRepairCodexWrapper(currentCommand: string, flags: CliFlags): void {
  if (!shouldAutoRepairCodexWrapper(currentCommand, flags)) return;
  try {
    repairCodexWrapperIfInstalled();
  } catch (err) {
    log.debug(`codex wrapper not repaired: ${errorMessage(err)}`, errorFields(err));
  }
}

const ROWS: readonly VerbSpec[] = Object.values(COMMANDS);

const COMMAND_INDEX: ReadonlyMap<string, VerbSpec> = new Map(
  Object.entries<VerbSpec>(COMMANDS).flatMap(([verb, spec]) =>
    [verb, ...(spec.aliases ?? [])].map((name): [string, VerbSpec] => [name, spec]),
  ),
);

export function usageText(): string {
  const blocks = [
    ...ROWS.flatMap((row) => row.usage ?? []),
    ...ROWS.flatMap((row) => row.listedLast ?? []),
  ];
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

function printVersion(): never {
  console.log(readPackageVersion());
  throw new CliExit(0);
}

function rejectEmptyScope(flags: CliFlags): void {
  if ('scope' in flags && (!isStringFlag(flags['scope']) || !flags['scope'].trim())) {
    fail('--scope requires a non-empty value (e.g. --scope slack:private:C1).');
  }
}

function rejectNonNumericFlags(flags: CliFlags, declared: VerbFlags | undefined): void {
  for (const [key, raw] of Object.entries(flags)) {
    if (flagKind(declared, key) !== 'number') continue;
    if (!isStringFlag(raw) || !raw.trim() || !Number.isFinite(Number(raw))) {
      fail(`--${key} requires a numeric value.`);
    }
  }
}

function rejectValuedSwitches(flags: CliFlags, declared: VerbFlags | undefined): void {
  for (const [key, raw] of Object.entries(flags)) {
    if (flagKind(declared, key) === 'switch' && !isBooleanFlag(raw)) {
      fail(`--${key} takes no value`);
    }
  }
}

function checkUnknownFlags(command: string, flags: CliFlags, spec: VerbSpec | undefined): void {
  const declared = spec?.flags;
  if (command === 'card') return;
  for (const [name, advice] of Object.entries(spec?.removedFlags ?? {})) {
    if (Object.hasOwn(flags, name)) {
      fail(`hippo ${command}: --${name} was removed in 3.0. ${advice}`);
    }
  }
  const flagNames = (keys: readonly string[]): string => keys.map((key) => `--${key}`).join(', ');
  const unknown = Object.keys(flags).filter((key) => !isKnownFlag(key));
  if (unknown.length > 0 && spec?.destructive) {
    printError(`Unknown flag ${flagNames(unknown)} for hippo ${command}. Nothing was changed.`);
    throw new CliExit(2);
  }
  const ignored = declared
    ? undeclaredFlags(declared, Object.keys(flags)).filter((key) => key !== 'dry-run')
    : unknown;
  if (ignored.length > 0) {
    printError(
      `hippo: ignoring unknown flag ${flagNames(ignored)}. A later release will reject it.`,
    );
  }
}

function stopReadOnly(command: string, mode: 'refuse' | 'skip'): void {
  if (mode === 'skip') {
    log.warn(`hippo ${command}: skipped under HIPPO_READ_ONLY=1`);
    return;
  }
  fail(READ_ONLY_REFUSAL);
}

async function main(
  command: string,
  args: string[],
  flags: CliFlags,
  hippoRoot: string,
): Promise<void> {
  if (command === '--version' || command === '-v' || boolFlag(flags, 'version')) printVersion();
  if (command === '' || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    return;
  }
  if (Object.hasOwn(flags, 'help')) {
    printHelp(command, args);
    return;
  }
  const spec = COMMAND_INDEX.get(command);
  maybeRepairCodexWrapper(command, flags);
  rejectEmptyScope(flags);
  rejectNonNumericFlags(flags, spec?.flags);
  rejectValuedSwitches(flags, spec?.flags);
  checkUnknownFlags(command, flags, spec);
  const refusal = Object.hasOwn(flags, 'dry-run')
    ? dryRunRefusal(command, spec, args, flags)
    : null;
  if (refusal) {
    printError(refusal);
    throw new CliExit(2);
  }
  if (!spec) {
    printError(`Unknown command: ${command}`);
    printUsage();
    throw new CliExit(1);
  }
  assertVerbPorted(spec, CLI_STORE);
  if (spec.readOnly !== undefined && envReadOnly()) {
    stopReadOnly(command, spec.readOnly);
    return;
  }
  const run = (): void | Promise<void> =>
    spec.run({ hippoRoot, tenantId: envTenant(), args, flags });
  await (spec.scoped ? (await import('./surface/cli/api-context.js')).cliRequest(run) : run());
}

function warnUnknownFlagValues(): void {
  for (const entry of validateFlags()) {
    log.warn(`${entry} is not 1, true, on, 0, false or off; the flag takes its safe side`);
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const { command, args, flags } = parseArgs(argv);
  warnUnknownFlagValues();
  try {
    await runCliCommand(() => main(command, args, flags, getHippoRoot(process.cwd())));
  } catch (err) {
    // The verb printed its own message. The process ends as a success does, never by process.exit,
    // which on Windows aborts Node (libuv async.c) while a fetch still has work in flight.
    if (err instanceof CliExit) {
      process.exitCode = err.code;
      return;
    }
    printError(
      'Error:',
      isStoreBusy(err) ? STORE_BUSY_MESSAGE : err instanceof Error ? err.message : err,
    );
    if (isLevelEnabled('debug')) {
      const fields = errorFields(err);
      const stack = fields.stack ? `\n${fields.stack}` : '';
      const cause = fields.cause ? `\n  caused by ${fields.cause}` : '';
      printError(`  thrown as ${fields.errorClass}${stack}${cause}`);
    }
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (
  entryPath &&
  fs.existsSync(entryPath) &&
  fs.realpathSync(entryPath) === fileURLToPath(import.meta.url)
) {
  runCli().catch((err) => {
    log.error('hippo: the command could not start', errorFields(err));
    process.exitCode = 1;
  });
}
