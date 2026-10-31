// hippo.db's embedding index on its local tier: the steps an index session runs and the shapes they pass.

// A store's own vector index, worked through sessions so the write lock and a rebuild's staged
// vectors stay on the thread that holds one. Vectors carry no tenant, so each step covers the
// whole store.
export interface EmbeddingIndex {
  /** Opens a session that holds nothing yet. */
  open(): Promise<IndexSession>;
  /** Runs one step on the open session `session`; `close` ends it. */
  step<K extends IndexStepKind>(session: string, step: IndexStep<K>): Promise<IndexStepAnswers[K]>;
}

/** `id` names the session to `step`; `key` names the store's hippo.db, so sessions on one file
 * in this process take turns and sessions on another do not. */
export interface IndexSession {
  readonly id: string;
  readonly key: string;
}

type NoFields = Record<never, never>;

/** What each step takes beside its kind. */
export interface IndexStepFields {
  /** Takes the index's write lock until `close`; other processes and threads on the store honour
   * it, and it answers false while a live holder has it. */
  readonly lock: NoFields;
  /** Opens a rebuild whose vectors wait apart from the live index. */
  readonly begin: NoFields;
  /** Stages one page of the rebuild, skipping empty or non-finite vectors; answers how many it
   * staged. */
  readonly stage: { readonly rows: readonly VectorRow[] };
  /** In one transaction, replaces every stored vector with the staged ones and records `model`
   * as what built them, then drops the staging, committed or not. */
  readonly commit: { readonly model: string };
  /** Drops a rebuild not committed, which leaves the live index as it was, releases the lock
   * this session took, and ends the session. */
  readonly close: NoFields;
  /** Whether another model than `providerId` built the stored vectors; an unreadable index
   * answers false. */
  readonly reindex: { readonly providerId: string };
  /** Records `providerId`'s index identity as what built the vectors. */
  readonly saveModel: { readonly providerId: string };
  /** Up to `page.limit` memory ids in id order after `page.afterId`: a re-embed needs each row
   * once, not time order. */
  readonly ids: { readonly page: IdPageRequest };
  /** `ids` for the memories with no vector only. */
  readonly pending: { readonly page: IdPageRequest };
  /** Upserts each row under `model`, one commit per row so a failure keeps those before it;
   * answers how many. */
  readonly save: { readonly rows: readonly VectorRow[]; readonly model: string };
  /** Drops the vectors of deleted memories. */
  readonly prune: NoFields;
  readonly summary: NoFields;
  /** How many memories and vectors the store holds, and how many memories have a vector. */
  readonly coverage: NoFields;
}

export type IndexStepKind = keyof IndexStepFields;

/** One step of kind `K`, plain data so it crosses to a store worker. */
export type IndexStep<K extends IndexStepKind = IndexStepKind> = {
  [P in K]: { readonly kind: P } & IndexStepFields[P];
}[K];

export interface IndexStepAnswers {
  readonly lock: boolean;
  readonly begin: void;
  readonly stage: number;
  readonly commit: void;
  readonly close: void;
  readonly reindex: boolean;
  readonly saveModel: void;
  readonly ids: IdPage;
  readonly pending: IdPage;
  readonly save: number;
  readonly prune: void;
  readonly summary: StoredVectorSummary;
  readonly coverage: VectorCoverage;
}

/** One memory's vector. */
export type VectorRow = readonly [memoryId: string, vector: readonly number[]];

/** A page in id order: up to `limit` ids after `afterId`, or from the first id when it is unset. */
export interface IdPageRequest {
  readonly limit: number;
  readonly afterId?: string;
}

/** A page of memory ids in id order, and the id the next page starts after; null on the last
 * page. */
export interface IdPage {
  readonly ids: string[];
  readonly next: string | null;
}

export interface VectorCoverage {
  readonly memories: number;
  readonly vectors: number;
  /** Memories with a vector; the other vectors are orphans of deleted memories. */
  readonly embedded: number;
}

export interface StoredVectorSummary {
  /** Stored vectors, orphans of deleted memories included. */
  readonly vectors: number;
  readonly dims: number | undefined;
}
