import type { CliFlags, CommandContext } from './flag-values.js';
import type { VerbFlags } from './flags.js';
import type { OptionalGroup } from '../../base/ports/store.js';

type Handler = (ctx: CommandContext) => void | Promise<void>;

/** A verb that honours --dry-run in one form only, where every other form writes for real. */
export interface DryRunForm {
  readonly form: string;
  readonly honoured: (args: readonly string[], flags: CliFlags) => boolean;
}

/** What a verb declares; its key in the table is its name, and the table's order is the help
 * listing's. */
export interface VerbRow {
  readonly flags: VerbFlags;
  readonly removedFlags?: Readonly<Record<string, string>>;
  readonly usage?: readonly string[];
  readonly listedLast?: readonly string[];
  readonly aliases?: readonly string[];
  readonly needs?: readonly OptionalGroup[];
  readonly scoped?: true;
  readonly repairsCodexWrapper?: true;
  readonly destructive?: true;
  readonly dryRun?: false | DryRunForm;
  readonly readOnly?: 'refuse' | 'skip';
}

export interface VerbSpec extends VerbRow {
  readonly run: (ctx: CommandContext) => Promise<void>;
}

/** A row whose module loads on its first run; `handler` must be an export of that module taking
 * a CommandContext. */
export function verb<K extends string, M extends Readonly<Record<K, Handler>>>(
  load: () => Promise<M>,
  handler: K,
  row: VerbRow,
): VerbSpec {
  return {
    ...row,
    run: async (ctx) => {
      await (await load())[handler](ctx);
    },
  };
}
