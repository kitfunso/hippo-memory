// One handler set for the kinds that evolve by supersession (brief, note, policy, process, skill), each driven by a descriptor.

import { extractPathTags } from '../search/path-context.js';
import { errorMessage } from '../util/log.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, stringFlag, type CliFlags, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { closeObject, foundOrExit, idArgOrExit, listObjects, printLifecycleTail, type ObjectNames } from './object-verbs.js';
import { CliExit } from './exit.js';

type VersionedRow = Parameters<typeof printLifecycleTail>[0] & { readonly id: number; readonly version: number };

/** The predecessor a new version replaces, and the delta note it carries. */
export interface Succession {
  readonly id: number;
  readonly changeSummary: string | undefined;
}

/** How one kind reads, saves and prints; `O` is its row, `S` its status, `B` the body flags a version is saved from. */
export interface VersionedKind<O extends VersionedRow, S extends string, B> {
  readonly names: ObjectNames;
  readonly plural: string;
  readonly states: ReadonlySet<S>;
  /** Printed when `new` lacks its key or its body. */
  readonly usage: readonly string[];
  readonly supersedeUsage: string;
  /** Named in the refusal of a supersede without a body: `requires <this> for the new version`. */
  readonly bodyRequired: string;
  /** The body of a new version, or undefined when its required flag is missing or blank. */
  readonly body: (flags: CliFlags, verb: 'new' | 'supersede') => B | undefined;
  /** What a new version keeps from the one it supersedes: the repo, customer or name. */
  readonly keyOf: (o: O) => string;
  readonly save: (key: string, body: B, extraTags: string[], from?: Succession) => O;
  /** The first line `new` prints. */
  readonly recorded: (o: O) => string;
  readonly list: (opts: { status?: S; limit: number }, flags: CliFlags) => readonly O[];
  readonly loadById: (id: number) => O | null;
  readonly close: (id: number) => { id: number };
  readonly printRow: (o: O) => void;
  /** The `get` lines between the header and the lifecycle tail. */
  readonly printDetail: (o: O) => void;
  /** A subcommand only this kind has. */
  readonly extra?: { readonly sub: string; readonly run: (args: string[], flags: CliFlags) => void };
}

/** A flag that must carry text: its raw value, or undefined when absent or blank. */
export function requiredText(flags: CliFlags, name: string): string | undefined {
  const raw = stringFlag(flags, name);
  return raw?.trim() ? raw : undefined;
}

/** The `hippo <cmd>` handler for a kind; `kindAt` binds the descriptor to the store the command runs against. */
export function versionedVerbs<O extends VersionedRow, S extends string, B>(
  kindAt: (hippoRoot: string, tenantId: string) => VersionedKind<O, S, B>,
): (ctx: CommandContext) => void {
  return ({ hippoRoot, tenantId, args, flags }) => {
    requireInit(hippoRoot);
    const kind = kindAt(hippoRoot, tenantId);
    const sub = args[0] ?? '';
    if (sub === kind.extra?.sub) return kind.extra.run(args, flags);
    if (sub === 'list') {
      return listObjects(flags, { plural: kind.plural, states: kind.states, load: (opts) => kind.list(opts, flags), printRow: kind.printRow });
    }
    if (sub === 'get') return getVersion(kind, args);
    if (sub === 'supersede') return supersedeVersion(kind, args, flags);
    if (sub === 'close') return closeObject(args, kind.names, kind.close);
    // Both `<cmd> new "<key>"` and the bare `<cmd> "<key>"` create.
    createVersion(kind, sub === 'new' ? (args[1] ?? '') : sub, flags);
  };
}

function getVersion<O extends VersionedRow, S extends string, B>(kind: VersionedKind<O, S, B>, args: string[]): void {
  const id = idArgOrExit(args, `Usage: hippo ${kind.names.cmd} get <id>`, kind.names.idLabel);
  const o = foundOrExit(kind.loadById(id), kind.names.noun, id);
  console.log(`${kind.names.noun} #${o.id}`);
  kind.printDetail(o);
  printLifecycleTail(o);
}

function createVersion<O extends VersionedRow, S extends string, B>(kind: VersionedKind<O, S, B>, key: string, flags: CliFlags): void {
  const body = key ? kind.body(flags, 'new') : undefined;
  if (body === undefined) {
    for (const line of kind.usage) printError(line);
    throw new CliExit(1);
  }
  const created = saveVersion(kind, key, body);
  printSaved(kind.recorded(created), created);
}

function supersedeVersion<O extends VersionedRow, S extends string, B>(kind: VersionedKind<O, S, B>, args: string[], flags: CliFlags): void {
  const id = idArgOrExit(args, kind.supersedeUsage, kind.names.idLabel);
  const body = kind.body(flags, 'supersede');
  if (body === undefined) {
    printError(`hippo ${kind.names.cmd} supersede requires ${kind.bodyRequired} for the new version.`);
    throw new CliExit(1);
  }
  // The lookup only gives a missing id its not-found line; the save's own preflight is the authoritative active-state check.
  const existing = foundOrExit(kind.loadById(id), kind.names.noun, id);
  const created = saveVersion(kind, kind.keyOf(existing), body, { id, changeSummary: nonEmptyStringFlag(flags, 'change') });
  printSaved(`${kind.names.noun} #${created.id} recorded (v${created.version}), superseding #${id}.`, created);
}

/** Every kind's save goes through here, so a refused write always prints the store's message and exits 1. */
function saveVersion<O extends VersionedRow, S extends string, B>(kind: VersionedKind<O, S, B>, key: string, body: B, from?: Succession): O {
  try {
    return kind.save(key, body, extractPathTags(process.cwd()), from);
  } catch (e) {
    printError(errorMessage(e));
    throw new CliExit(1);
  }
}

function printSaved(line: string, o: VersionedRow): void {
  console.log(line);
  if (o.memoryId) console.log(`  memory: ${o.memoryId}`);
}
