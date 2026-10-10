// The status, list, id and not-found paths the typed-object verbs (process, policy, skill, brief, note, decide, incident, predict) share.

import { printError } from './output.js';
import { parseListLimit, parsePositiveId, stringFlag, type CliFlags } from './flag-values.js';
import { CliExit } from './exit.js';

/** The member of `states` named by `status`, or exit 1 with the message that lists every allowed value. */
export function requireStatus<S extends string>(status: string, states: ReadonlySet<S>): S {
  const found = [...states].find((s) => s === status);
  if (found === undefined) {
    printError(`Invalid --status: "${status}". Must be one of: ${[...states, 'all'].join(' | ')}.`);
    throw new CliExit(1);
  }
  return found;
}

/** `--status` checked against the kind's states; undefined when absent or `all`. */
export function statusFilter<S extends string>(flags: CliFlags, states: ReadonlySet<S>): S | undefined {
  const status = stringFlag(flags, 'status')?.trim() ?? 'all';
  return status === 'all' ? undefined : requireStatus(status, states);
}

export interface ObjectListSpec<O, S extends string> {
  readonly plural: string;
  readonly states: ReadonlySet<S>;
  readonly load: (opts: { status?: S; limit: number }) => readonly O[];
  readonly printRow: (o: O) => void;
}

export function listObjects<O, S extends string>(flags: CliFlags, spec: ObjectListSpec<O, S>): void {
  const limit = parseListLimit(flags);
  const status = statusFilter(flags, spec.states);
  const results = spec.load(status === undefined ? { limit } : { status, limit });
  if (results.length === 0) {
    console.log(`No ${spec.plural}.`);
    return;
  }
  console.log(`Found ${results.length} ${spec.plural}:\n`);
  for (const o of results) spec.printRow(o);
}

/** The `<id>` after the subcommand; prints `usage` and exits 1 when it is missing. */
export function idArgOrExit(
  args: string[],
  usage: string,
  label: string,
  parseId: (raw: string, label: string) => number = parsePositiveId,
): number {
  const idRaw = args[1];
  if (!idRaw) {
    printError(usage);
    throw new CliExit(1);
  }
  return parseId(idRaw, label);
}

export function foundOrExit<O>(found: O | null | undefined, noun: string, id: number): O {
  if (!found) {
    printError(`${noun} ${id} not found.`);
    throw new CliExit(1);
  }
  return found;
}

/** How a kind is named in usage lines (`cmd`), in messages (`noun`) and in the invalid-id error (`idLabel`). */
export interface ObjectNames {
  readonly cmd: string;
  readonly noun: string;
  readonly idLabel: string;
}

/** `hippo <cmd> close <id>` for a kind whose close call returns the closed row. */
export function closeObject(
  args: string[],
  names: ObjectNames,
  close: (id: number) => { id: number },
  parseId: (raw: string, label: string) => number = parsePositiveId,
): void {
  const id = idArgOrExit(args, `Usage: hippo ${names.cmd} close <id>`, names.idLabel, parseId);
  console.log(`${names.noun} #${close(id).id} closed.`);
}

interface LifecycleTail {
  readonly changeSummary?: string | null;
  readonly supersededBy: number | null;
  readonly supersededAt?: string | null;
  readonly closedAt?: string | null;
  readonly memoryId?: string | null;
  readonly createdAt: string;
}

/** The detail lines every `get` ends with. */
export function printLifecycleTail(o: LifecycleTail): void {
  if (o.changeSummary) console.log(`  change_summary: ${o.changeSummary}`);
  if (o.supersededBy !== null) console.log(`  superseded_by: #${o.supersededBy}`);
  if (o.supersededAt) console.log(`  superseded_at: ${o.supersededAt}`);
  if (o.closedAt) console.log(`  closed_at: ${o.closedAt}`);
  if (o.memoryId) console.log(`  memory: ${o.memoryId}`);
  console.log(`  created: ${o.createdAt}`);
}
