import type { KeysetPosition } from '../../base/util/keyset.js';
import type {
  ObjectByKind,
  ObjectFields,
  ObjectKind,
  SavableKind,
} from '../../base/records/object-types.js';

export interface ObjectDescriptor<K extends ObjectKind> {
  readonly kind: K;
  readonly label: string;
  readonly plural: string;
  readonly states: ReadonlySet<ObjectByKind[K]['status']>;
  readonly closableFrom: readonly ObjectByKind[K]['status'][];
  readonly closeRefusal?: string;
}

/** One save, checked and resolved before a store is asked. */
export interface ObjectDraft<K extends SavableKind> {
  readonly fields: ObjectFields[K];
  readonly content: string;
  readonly tags: readonly string[];
  readonly supersedesId: number | undefined;
  readonly changeSummary?: string;
  readonly weakensMemoryId?: string;
  readonly at: string;
}

/** A kind the shared save writes: active rows, replaced by supersede. `W` is the options its
 * module's save takes. */
export interface SavableDescriptor<K extends SavableKind, W> extends ObjectDescriptor<K> {
  readonly draft: (opts: W, now: Date) => ObjectDraft<K>;
}

export interface ObjectListOptions<K extends ObjectKind> {
  status?: ObjectByKind[K]['status'];
  filter?: string;
  limit?: number;
  after?: KeysetPosition;
}
