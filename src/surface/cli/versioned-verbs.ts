import { errorMessage } from '../../base/util/log.js';
import type { ObjectByKind } from '../../base/records/object-types.js';
import type { ContextWith } from '../../api/types.js';
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
import {
  nonEmptyStringFlag,
  stringFlag,
  type CliFlags,
  type CommandContext,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { cliApiContext } from './api-context.js';
import {
  closeObjectVerb,
  foundOrExit,
  idArgOrExit,
  listObjectsVerb,
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

/** How one kind reads its flags and prints; `K` is its kind, `B` the body flags a version is
 * saved from. */
export interface VersionedKind<K extends VersionedKindName, B> {
  readonly kind: K;
  readonly names: ObjectNames;
  readonly plural: string;
  readonly usage: readonly string[];
  readonly supersedeUsage: string;
  readonly bodyRequired: string;
  readonly body: (flags: CliFlags, verb: 'new' | 'supersede') => B | undefined;
  readonly keyOf: (o: ObjectByKind[K]) => string;
  readonly write: (key: string, body: B, from?: Succession) => ObjectWrites[K];
  readonly recorded: (o: ObjectByKind[K]) => string;
  readonly filterFlag?: string;
  readonly printRow: (o: ObjectByKind[K]) => void;
  readonly printDetail: (o: ObjectByKind[K]) => void;
  readonly extra?: {
    readonly sub: string;
    readonly run: (ctx: ContextWith<'objects'>, args: string[], flags: CliFlags) => Promise<void>;
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
      const filter =
        kind.filterFlag === undefined ? undefined : stringFlag(flags, kind.filterFlag)?.trim();
      return listObjectsVerb(flags, {
        plural: kind.plural,
        states: objectStates(kind.kind),
        load: (opts) => objectList(ctx, kind.kind, { ...opts, filter }),
        printRow: kind.printRow,
      });
    }
    if (sub === 'get') return getVersion(ctx, kind, args);
    if (sub === 'supersede') return supersedeVersion(ctx, kind, args, flags);
    if (sub === 'close') {
      return closeObjectVerb(args, kind.names, (id) => objectClose(ctx, kind.kind, id));
    }
    await createVersion(ctx, kind, sub === 'new' ? (args[1] ?? '') : sub, flags);
  };
}

async function getVersion<K extends VersionedKindName, B>(
  ctx: ContextWith<'objects'>,
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
  ctx: ContextWith<'objects'>,
  kind: VersionedKind<K, B>,
  key: string,
  flags: CliFlags,
): Promise<void> {
  const body = key ? kind.body(flags, 'new') : undefined;
  if (body === undefined) {
    for (const line of kind.usage) printError(line);
    throw new CliExit(1);
  }
  const created = await refusalExits(() =>
    objectCreate(ctx, kind.kind, kind.write(key, body), shellFolder()),
  );
  printSaved(kind.recorded(created), created);
}

async function supersedeVersion<K extends VersionedKindName, B>(
  ctx: ContextWith<'objects'>,
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
  const created = await refusalExits(() =>
    objectCreate(ctx, kind.kind, kind.write(kind.keyOf(existing), body, from), shellFolder()),
  );
  printSaved(
    `${kind.names.noun} #${created.id} recorded (v${created.version}), superseding #${id}.`,
    created,
  );
}

/** A CLI write is made in the shell's folder, whose path segments tag its mirror memory. */
export function shellFolder(): WriteOrigin {
  return { folder: process.cwd() };
}

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
