import type {
  BriefReceipt,
  Incident,
  IncidentFields,
  ObjectByKind,
  ObjectFields,
  ObjectKind,
  ObjectRefusal,
  Policy,
  SavableKind,
  Skill,
} from '../../records/object-types.js';
import type { KeysetPosition } from '../../util/keyset.js';
import type { MemoryEntry } from '../../memory/entry.js';
import type { ClosureState } from '../../records/prediction.js';
import type { PredictionBaserate } from './types.js';

/** Which of a tenant's rows of one kind a list reads: every status when `status` is unset, every
 * value of the kind's one filter column (customer, repo) when `filter` is, every mirror when
 * `memoryId` is. None is ever empty; a kind with no filter column ignores `filter`. */
export interface ObjectListQuery<K extends ObjectKind = ObjectKind> {
  readonly status?: ObjectByKind[K]['status'];
  readonly filter?: string;
  readonly memoryId?: string;
  readonly limit: number;
  readonly after?: KeysetPosition;
}

export interface ObjectClose<K extends ObjectKind = ObjectKind> {
  /** The statuses a close may start from; core owns the rule and its refusal text. */
  readonly from: readonly ObjectByKind[K]['status'][];
  readonly actor: string;
  /** The row's closedAt: core's clock, as `toISOString` gives it. */
  readonly at: string;
}

/** One row to save and the memory that mirrors it into recall: core builds the mirror in the
 * tenant the save names with the kind as its `source`, so every store keeps the same row. */
export interface ObjectSave<K extends SavableKind = SavableKind> {
  readonly mirror: MemoryEntry;
  readonly fields: ObjectFields[K];
  /** The tenant's active row this one replaces. */
  readonly supersedesId?: number;
  /** Stored on a successor of a versioned kind only; a first version and a decision keep none. */
  readonly changeSummary?: string;
  readonly actor: string;
  /** The new row's createdAt and the replaced row's supersededAt: core's clock, as `toISOString`
   * gives it, since the list orders createdAt as text. */
  readonly at: string;
}

/** An incident to open and the memory that mirrors it into recall, built as `ObjectSave` has it. */
export interface IncidentOpen {
  readonly mirror: MemoryEntry;
  readonly fields: IncidentFields;
  readonly actor: string;
  /** The row's createdAt: core's clock, as `toISOString` gives it. */
  readonly at: string;
}

/** Why an incident was not opened: `memoryId` is the first linked id, in the order given, that
 * is no memory of the tenant; or the written row could not be read back. */
export type IncidentOpenRefusal =
  | { readonly refused: 'unlinked'; readonly memoryId: string }
  | { readonly refused: 'vanished' };

export interface IncidentResolve {
  /** The row's resolutionText; core has checked it is not blank. */
  readonly text: string;
  readonly actor: string;
  /** The row's resolvedAt: core's clock, as `toISOString` gives it. */
  readonly at: string;
}

/** `asOf` is an instant as `toISOString` gives it, so it compares as text against validFrom and
 * validTo; `name` keeps one policyName, and may be empty. */
export interface PoliciesInForceQuery {
  readonly asOf: string;
  readonly name?: string;
  readonly limit: number;
}

/** Skills in one status ordered by skillName ascending compared as text in byte order, then by
 * id ascending. */
export interface SkillsByNameQuery {
  readonly byName: true;
  readonly status: Skill['status'];
  readonly limit: number;
}

/** The reads and writes behind the typed-object and prediction routes, each kind's typed payload
 * under one call. An audit row names the object under the kind's id key (decision_id,
 * incident_id, prediction_id, ...). A row belongs to one tenant: another tenant's id reads as
 * missing in every method. */
export interface Objects {
  /** At most `limit` rows of the kind, newest first: by createdAt compared as text in byte
   * order, then by id, both descending, so the order is total. `after` keeps only the rows below
   * its (createdAt, id) pair in that order; `memoryId` only the rows that memory mirrors. No
   * audit row. */
  listObjects<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    query: ObjectListQuery<K>,
  ): Promise<ObjectByKind[K][]>;
  /** Policies in force at `asOf` (max `limit`): not closed, validFrom <= asOf < validTo (or
   * unset), and active or superseded by a row whose validFrom is after asOf. Newest validFrom
   * first, compared as text in byte order, then larger id. No audit row. */
  listObjects(tenantId: string, kind: 'policy', query: PoliciesInForceQuery): Promise<Policy[]>;
  /** At most `limit` of the tenant's skills in `status`, in the query's by-name order. No audit
   * row. */
  listObjects(tenantId: string, kind: 'skill', query: SkillsByNameQuery): Promise<Skill[]>;
  /** At most `limit` predictions, in the newest-first order of the typed objects. No audit row. */
  listObjects(
    tenantId: string,
    kind: 'prediction',
    query: PredictionListQuery,
  ): Promise<Prediction[]>;
  /** The tenant's row; null for a missing id or another tenant's. No audit row. */
  objectById<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    id: number,
  ): Promise<ObjectByKind[K] | null>;
  objectById(tenantId: string, kind: 'prediction', id: number): Promise<Prediction | null>;
  /** In one transaction: moves the tenant's row from a `close.from` status to closed at
   * `close.at` and appends one <kind>_close row; a refusal writes nothing. After the commit a
   * kind the graph reads has its graph rows dropped and its mirror queued for a rebuild; a
   * failure there is logged, never thrown. */
  closeObject<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    id: number,
    close: ObjectClose<K>,
  ): Promise<ObjectByKind[K] | ObjectRefusal>;
  /** In one transaction: moves the tenant's incident from open to resolved with `resolve.text`
   * and `resolve.at`, then appends one incident_resolve row. A refusal (`missing`, `status`, or
   * `vanished`) writes nothing. */
  closeObject(
    tenantId: string,
    kind: 'incident',
    id: number,
    resolve: IncidentResolve,
  ): Promise<Incident | ObjectRefusal>;
  /** Closes the tenant's open prediction and appends one predict_close row ({prediction_id,
   * closure_state, has_actual}) in one transaction; the mirror stays as saved. A missing or
   * other-tenant id rejects with NotFoundError, an already-closed row with BadRequestError;
   * neither writes anything. */
  closeObject(
    tenantId: string,
    kind: 'prediction',
    id: number,
    close: PredictionClose,
  ): Promise<Prediction>;
  /** In one transaction, in order: writes `mirror` as `EntryWrites.writeEntry` does; inserts the
   * row active (version 1, or the replaced row's plus one); with `supersedesId`, supersedes that
   * row; appends the supersede and create rows. A refusal (`missing`, `status`, `raced`,
   * `vanished`) writes nothing. */
  saveObject<K extends SavableKind>(
    tenantId: string,
    kind: K,
    save: ObjectSave<K>,
  ): Promise<ObjectByKind[K] | ObjectRefusal>;
  /** In one transaction, in order: writes `mirror` as `EntryWrites.writeEntry` does; checks each
   * linked id is a memory of the tenant; inserts the row open under the next id; appends the
   * incident_open row, then the mirror's remember row. A refusal leaves no mirror, row or audit
   * row. */
  saveObject(
    tenantId: string,
    kind: 'incident',
    open: IncidentOpen,
  ): Promise<Incident | IncidentOpenRefusal>;
  /** In one transaction: writes `mirror` as `EntryWrites.writeEntry` does, inserts the open row
   * under the next id, and appends one predict_create row ({prediction_id, class_tag,
   * has_estimate, target_date}) ahead of the mirror's remember row. Resolves to the row saved. */
  saveObject(tenantId: string, kind: 'prediction', save: PredictionSave): Promise<Prediction>;
  /** At most `limit` of the tenant's memories carrying `tag` (tag list as JSON, matched between
   * double quotes, unescaped, ASCII case-folded) whose source is not project_brief and whose
   * scope recall admits with no scope asked, newest first by created (text, byte order) then id.
   * No audit row. It reads memories, not object rows. */
  briefReceipts(tenantId: string, tag: string, limit: number): Promise<BriefReceipt[]>;
  /** `predictionBaserateOf` over the tenant's closed (not closed-unknown) rows of the class with
   * an estimate and an actual, in ascending id order (its float sums depend on it). Then appends
   * one predict_baserate row ({class_tag, n_closed}), also for a class with no such row. One
   * aggregate statement, so it is not a list of rows. */
  predictionBaserate(
    tenantId: string,
    classTag: string,
    actor: string,
  ): Promise<PredictionBaserate>;
}

/** Each method's overloads as one argument list, so an adapter writes one body per method: the
 * kind and the payload's shape pick the statement. */
export type ObjectListArgs =
  | [tenantId: string, kind: 'prediction', query: PredictionListQuery]
  | [
      tenantId: string,
      kind: ObjectKind,
      query: ObjectListQuery | PoliciesInForceQuery | SkillsByNameQuery,
    ];
export type ObjectCloseArgs =
  | [tenantId: string, kind: 'prediction', id: number, close: PredictionClose]
  | [tenantId: string, kind: ObjectKind, id: number, close: ObjectClose | IncidentResolve];
export type ObjectSaveArgs =
  | [tenantId: string, kind: 'prediction', save: PredictionSave]
  | [tenantId: string, kind: 'incident', open: IncidentOpen]
  | [tenantId: string, kind: SavableKind, save: ObjectSave];

type AnyObject = ObjectByKind[ObjectKind] | Prediction;

/** `Objects` as an adapter writes it, one signature per method; the port's overloads pair each
 * kind with its answer. */
export interface ObjectCalls {
  listObjects(...args: ObjectListArgs): Promise<AnyObject[]>;
  objectById(
    tenantId: string,
    kind: ObjectKind | 'prediction',
    id: number,
  ): Promise<AnyObject | null>;
  closeObject(...args: ObjectCloseArgs): Promise<AnyObject | ObjectRefusal>;
  saveObject(...args: ObjectSaveArgs): Promise<AnyObject | ObjectRefusal | IncidentOpenRefusal>;
  briefReceipts: Objects['briefReceipts'];
  predictionBaserate: Objects['predictionBaserate'];
}

/** A claim to save, the memory row that mirrors it into recall and the actor its predict_create
 * row names: core builds the mirror with `predictionMirror` in the tenant the save names, so
 * every store keeps the same row. createdAt is the store's own clock at the write, as
 * `toISOString` gives it, since the list orders createdAt as text. */
export interface PredictionSave extends SavePredictionOptions {
  readonly mirror: MemoryEntry;
  readonly actor: string;
}

/** closedAt is the store's own clock at the write. */
export interface PredictionClose {
  readonly closureState: Exclude<ClosureState, 'open'>;
  readonly actualValue?: number;
  readonly closureNote?: string;
  readonly actor: string;
}

/** Which of a tenant's predictions a list reads: every class when `classTag` is unset (it is
 * never empty), every state when `closureState` is, and a closed state only inside a class. */
export type PredictionFilter =
  | { readonly classTag?: string; readonly closureState?: 'open' }
  | { readonly classTag: string; readonly closureState: ClosureState };

export type PredictionListQuery = PredictionFilter & {
  readonly limit: number;
  readonly after?: KeysetPosition;
};

export interface Prediction {
  id: number;
  /** Nullable: a memory may be deleted (forget / consolidate / archive) without breaking the
   * prediction row. */
  memoryId: string | null;
  tenantId: string;
  classTag: string;
  claimText: string;
  estimateValue: number | null;
  estimateUnit: string | null;
  targetDate: string | null;
  actualValue: number | null;
  closureState: ClosureState;
  closedAt: string | null;
  closureNote: string | null;
  createdAt: string;
}

export interface SavePredictionOptions {
  classTag: string;
  claimText: string;
  estimateValue?: number;
  estimateUnit?: string;
  targetDate?: string;
}
