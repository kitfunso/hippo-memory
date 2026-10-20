// One handler set for the kinds that evolve by supersession (brief, note, policy, process, skill), each driven by its
// kind's api calls.

import { errorMessage } from '../../base/util/log.js';
import type { ObjectByKind } from '../../base/records/object-types.js';
import type { Context } from '../../api/types.js';
import {
  objectClose,
  objectCreate,
  objectGet,
  objectList,
  objectStates,
  type ObjectWrites,
  type WriteOrigin,
} from '../../api/objects/objects.js';
import { printError } from './output.js';
import { nonEmptyStringFlag, stringFlag, type CliFlags, type CommandContext } from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import {
  closeObject,
  foundOrExit,
  idArgOrExit,
  listObjects,
  printLifecycleTail,
  type ObjectNames,
} from './object-verbs.js';
import { CliExit, fail } from './exit.js';

/** The kinds a new version replaces by supersession. */
export type VersionedKindName = 'process' | 'policy' | 'skill' | 'project_brief' | 'customer_note';

/** The predecessor a new version replaces, and the delta note it carries. */
export interface Succession {
  readonly id: number;
  readonly changeSummary: string | undefined;
}

/** How one kind reads its flags and prints; `K` is its kind, `B` the body flags a version is saved from. */
export interface VersionedKind<K extends VersionedKindName, B> {
  readonly kind: K;
  readonly names: ObjectNames;
  readonly plural: string;
  /** Printed when `new` lacks its key or its body. */
  readonly usage: readonly string[];
  readonly supersedeUsage: string;
  /** Named in the refusal of a supersede without a body: `requires <this> for the new version`. */
  readonly bodyRequired: string;
  /** The body of a new version, or undefined when its required flag is missing or blank. */
  readonly body: (flags: CliFlags, verb: 'new' | 'supersede') => B | undefined;
  /** What a new version keeps from the one it supersedes: the repo, customer or name. */
  readonly keyOf: (o: ObjectByKind[K]) => string;
  readonly write: (key: string, body: B, from?: Succession) => ObjectWrites[K];
  /** The first line `new` prints. */
  readonly recorded: (o: ObjectByKind[K]) => string;
  /** The `list` flag whose value the kind's filter column must equal. */
  readonly filterFlag?: string;
  readonly printRow: (o: ObjectByKind[K]) => void;
  /** The `get` lines between the header and the lifecycle tail. */
  readonly printDetail: (o: ObjectByKind[K]) => void;
  /** A subcommand only this kind has. */
  readonly extra?: {
    readonly sub: string;
    readonly run: (ctx: Context, args: string[], flags: CliFlags) => Promise<void>;
  };
}

/** A flag that must carry text: its raw value, or undefined when absent or blank. */
export function requiredText(flags: CliFlags, name: string): string | undefined {
  const raw = stringFlag(flags, name);
  return raw?.trim() ? raw : undefined;
}

/** The `hippo <cmd>` handler for a kind, each verb one api call on the command's store. */
export function versionedVerbs<K extends VersionedKindName, B>(
  kind: VersionedKind<K, B>,
): (cc: CommandContext) => Promise<void> {
  return async ({ hippoRoot, tenantId, args, flags }) => {
    requireInit(hippoRoot);
    const ctx = cliApiContext(hippoRoot, tenantId);
    const sub = args[0] ?? '';
    if (sub === kind.extra?.sub) return kind.extra.run(ctx, args, flags);
    if (sub === 'list') {
      const filter = kind.filterFlag === undefined ? undefined : stringFlag(flags, kind.filterFlag)?.trim();
      return listObjects(flags, {
        plural: kind.plural,
        states: objectStates(kind.kind),
        load: (opts) => objectList(ctx, kind.kind, { ...opts, filter }),
        printRow: kind.printRow,
      });
    }
    if (sub === 'get') return getVersion(ctx, kind, args);
    if (sub === 'supersede') return supersedeVersion(ctx, kind, args, flags);
    if (sub === 'close') return closeObject(args, kind.names, (id) => objectClose(ctx, kind.kind, id));
    // Both `<cmd> new "<key>"` and the bare `<cmd> "<key>"` create.
    await createVersion(ctx, kind, sub === 'new' ? (args[1] ?? '') : sub, flags);
  };
}

async function getVersion<K extends VersionedKindName, B>(
  ctx: Context,
  kind: VersionedKind<K, B>,
  args: string[],
): Promise<void> {
  const id = idArgOrExit(args, `Usage: hippo ${kind.names.cmd} get <id>`, kind.names.idLabel);
  const o = foundOrExit(await objectGet(ctx, kind.kind, id), kind.names.noun, id);
  console.log(`${kind.names.noun} #${o.id}`);
  kind.printDetail(o);
  printLifecycleTail(o);
}

async function createVersion<K extends VersionedKindName, B>(
  ctx: Context,
  kind: VersionedKind<K, B>,
  key: string,
  flags: CliFlags,
): Promise<void> {
  const body = key ? kind.body(flags, 'new') : undefined;
  if (body === undefined) {
    for (const line of kind.usage) printError(line);
    throw new CliExit(1);
  }
  const created = await refusalExits(() => objectCreate(ctx, kind.kind, kind.write(key, body), shellFolder()));
  printSaved(kind.recorded(created), created);
}

async function supersedeVersion<K extends VersionedKindName, B>(
  ctx: Context,
  kind: VersionedKind<K, B>,
  args: string[],
  flags: CliFlags,
): Promise<void> {
  const id = idArgOrExit(args, kind.supersedeUsage, kind.names.idLabel);
  const body = kind.body(flags, 'supersede');
  if (body === undefined) {
    fail(`hippo ${kind.names.cmd} supersede requires ${kind.bodyRequired} for the new version.`);
  }
  const existing = foundOrExit(await objectGet(ctx, kind.kind, id), kind.names.noun, id);
  const from = { id, changeSummary: nonEmptyStringFlag(flags, 'change') };
  // The lookup stays outside refusalExits so a store error reaches runCli;
  // the save's own check is the active-state one.
  const created = await refusalExits(() =>
    objectCreate(ctx, kind.kind, kind.write(kind.keyOf(existing), body, from), shellFolder()),
  );
  printSaved(`${kind.names.noun} #${created.id} recorded (v${created.version}), superseding #${id}.`, created);
}

/** A CLI write is made in the shell's folder, whose path segments tag its mirror memory. */
export function shellFolder(): WriteOrigin {
  return { folder: process.cwd() };
}

/** Every save goes through here, so a refused write always prints the store's message and exits 1. */
async function refusalExits<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (e) {
    fail(errorMessage(e));
  }
}

function printSaved(line: string, o: { readonly memoryId?: string | null }): void {
  console.log(line);
  if (o.memoryId) console.log(`  memory: ${o.memoryId}`);
}
