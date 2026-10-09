// The words and rules that differ between the typed objects (decision, project brief and the rest), held as data so one lifecycle serves every kind.
// A kind's table, columns and audit keys sit behind the `objects` store group.

import type { KeysetPosition } from '../util/keyset.js';
import type { ObjectByKind, ObjectFields, ObjectKind, SavableKind } from '../store/object-types.js';

export interface ObjectDescriptor<K extends ObjectKind> {
  readonly kind: K;
  /** The nouns error text uses: "brief 3 not found", "only active briefs". */
  readonly label: string;
  readonly plural: string;
  /** The exported function names; each one prefixes the errors of its own call. */
  readonly fn: { readonly get: string; readonly close: string; readonly list: string };
  readonly states: ReadonlySet<ObjectByKind[K]['status']>;
  /** The statuses a close may start from. */
  readonly closableFrom: readonly ObjectByKind[K]['status'][];
  /** Said in place of "not <closable statuses>" when a close is refused; incidents say "already closed". */
  readonly closeRefusal?: string;
}

/** One save, checked and resolved before a store is asked. */
export interface ObjectDraft<K extends SavableKind> {
  readonly fields: ObjectFields[K];
  /** The mirror memory's text, and its tags after the kind's own. */
  readonly content: string;
  readonly tags: readonly string[];
  /** The active object this one replaces. */
  readonly supersedesId: number | undefined;
  /** What changed; stored only on a versioned successor. */
  readonly changeSummary?: string;
  /** Read once the checks pass, so one instant stamps everything the save writes. */
  readonly at: string;
}

/** A kind the shared save writes: active rows, replaced by supersede. `W` is the options its module's save takes. */
export interface SavableDescriptor<K extends SavableKind, W> extends ObjectDescriptor<K> {
  readonly fn: { readonly get: string; readonly close: string; readonly list: string; readonly save: string };
  /** Throws BadRequestError for options the kind refuses. */
  readonly draft: (opts: W) => ObjectDraft<K>;
}

export interface ObjectListOpts<K extends ObjectKind> {
  status?: ObjectByKind[K]['status'];
  /** The value the kind's one filter column must equal: a customer note's customer, a project brief's repo. */
  filter?: string;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}
