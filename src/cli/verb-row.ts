// The shape of one row of the verb table, and the helper that builds it with a type-checked lazy import.

import type { CliFlags, CommandContext } from './flag-values.js';
import type { VerbFlags } from './flags.js';

type Handler = (ctx: CommandContext) => void | Promise<void>;

/** A verb that honours --dry-run in one form only, where every other form writes for real. */
export interface DryRunForm {
  /** Printed after `hippo <verb>` in the refusal, so an alias names itself. */
  readonly form: string;
  readonly honoured: (args: readonly string[], flags: CliFlags) => boolean;
}

/** What a verb declares; its key in the table is its name, and the table's order is the help listing's. */
export interface VerbRow {
  /** The flags this verb reads; any other flag still parses, and the verb says it ignores it. */
  readonly flags: VerbFlags;
  /** Help blocks, each opening with a newline so the full listing is their concatenation. */
  readonly usage?: readonly string[];
  /** Help blocks the full listing prints after every verb's own; `hippo <verb> --help` prints them last. */
  readonly listedLast?: readonly string[];
  readonly aliases?: readonly string[];
  /** Runs in a request scope, opening each store once; set on api-backed verbs, as hook verbs open their own. */
  readonly scoped?: true;
  /** Unset: --dry-run is honoured exactly when the verb declares it; `false` refuses it even so. */
  readonly dryRun?: false | DryRunForm;
}

export interface VerbSpec extends VerbRow {
  readonly run: (ctx: CommandContext) => Promise<void>;
}

/** A row whose module loads on its first run; `handler` must be an export of that module taking a CommandContext. */
export function verb<K extends string, M extends Readonly<Record<K, Handler>>>(
  load: () => Promise<M>,
  handler: K,
  row: VerbRow,
): VerbSpec {
  return { ...row, run: async (ctx) => { await (await load())[handler](ctx); } };
}
