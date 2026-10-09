// What differs between the typed objects (decision, project brief and the rest), held as data so one lifecycle serves every type.

import type { AuditOp } from '../audit.js';
import type { SourceObjectType } from '../graph/types.js';
import type { KeysetPosition } from '../keyset.js';
import type { JsonObject } from '../working-memory.js';

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
  /** Said in place of "not <closable statuses>" when a close is refused; incidents say "already closed". */
  readonly closeRefusal?: string;
  readonly ops: { readonly close: AuditOp };
  /** The audit metadata key that carries the object id. */
  readonly idKey: string;
  /** Set for the types the graph extracts, so a save marks the graph stale and a close drops the object's graph rows. */
  readonly graphType?: SourceObjectType;
  /** List option name to the column it must equal. */
  readonly listFilters: { readonly [K in F]: string };
  readonly rowTo: (row: R) => O;
}

/** What one column of a new row can hold. */
export type ColumnValue = string | number | null;

/** A type the shared save writes: active rows, replaced by supersede. `W` is the fields its module resolved for one write. */
export interface SavableDescriptor<O extends BaseObject, R, F extends string, W> extends ObjectDescriptor<O, R, F> {
  readonly fn: { readonly get: string; readonly close: string; readonly list: string; readonly save: string };
  readonly ops: { readonly close: AuditOp; readonly create: AuditOp; readonly supersede: AuditOp };
  /** The mirror memory's `source`, which is also its first tag. */
  readonly source: string;
  /** A versioned table has `version` and `change_summary`: a successor takes its predecessor's version plus one and the caller's change note. */
  readonly versioned: boolean;
  /** The type's own columns, in the order `values` fills them. */
  readonly columns: readonly string[];
  readonly values: (w: W) => readonly ColumnValue[];
  /** The create audit's keys after the id, in the order they are stored. */
  readonly createMeta: (w: W, version: number) => JsonObject;
  /** Keys the supersede audit stores after its own. */
  readonly supersedeMeta?: (w: W) => JsonObject;
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

/** One save, resolved by the module before anything is written. */
export interface ObjectSave<W> extends ObjectWrite {
  readonly fields: W;
  /** The mirror memory's text, and its tags after the type's own. */
  readonly content: string;
  readonly tags: readonly string[];
  /** The active object this one replaces. */
  readonly supersedesId: number | undefined;
  /** What changed; stored only on a versioned successor. */
  readonly changeSummary?: string;
}
