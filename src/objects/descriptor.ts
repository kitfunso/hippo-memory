// What differs between the typed objects (decision, project brief and the rest), held as data so one lifecycle serves every type.

import type { AuditOp } from '../audit.js';
import type { SourceObjectType } from '../graph/types.js';
import type { KeysetPosition } from '../keyset.js';

/** The fields the lifecycle reads off any typed object. */
export interface BaseObject {
  id: number;
  memoryId: string | null;
  status: string;
}

/** `O` is the object callers get, `R` its table row, `F` the list options that filter a column by equality. */
export interface ObjectDescriptor<O extends BaseObject, R, F extends string = never> {
  readonly table: string;
  /** The column list every read selects: exactly the columns `R` declares. */
  readonly cols: string;
  /** The nouns error text uses: "brief 3 not found", "only active briefs". */
  readonly label: string;
  readonly plural: string;
  /** The exported function names; each one prefixes the errors of its own call. */
  readonly fn: { readonly get: string; readonly close: string; readonly list: string };
  readonly states: ReadonlySet<O['status']>;
  /** The statuses a close may start from. */
  readonly closableFrom: readonly O['status'][];
  readonly ops: { readonly close: AuditOp };
  /** The audit metadata key that carries the object id. */
  readonly idKey: string;
  /** Set for the types the graph extracts, so a close also drops the object's graph rows. */
  readonly graphType?: SourceObjectType;
  /** List option name to the column it must equal. */
  readonly listFilters: { readonly [K in F]: string };
  readonly rowTo: (row: R) => O;
}

export type ObjectListOpts<O extends BaseObject, F extends string = never> = {
  status?: O['status'];
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
} & { readonly [K in F]?: string };

/** Who writes and when; the caller reads the clock so one instant can stamp everything a call writes. */
export interface ObjectWrite {
  readonly actor: string;
  readonly now: string;
}
