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
import type { MethodEffects } from './effects.js';

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
  readonly from: readonly ObjectByKind[K]['status'][];
  readonly actor: string;
  readonly at: string;
}

/** One row to save and the memory that mirrors it into recall: core builds the mirror in the
 * tenant the save names with the kind as its `source`, so every store keeps the same row. */
export interface ObjectSave<K extends SavableKind = SavableKind> {
  readonly mirror: MemoryEntry;
  readonly fields: ObjectFields[K];
  readonly supersedesId?: number;
  readonly changeSummary?: string;
  readonly weakensMemoryId?: string;
  readonly actor: string;
  readonly at: string;
}

/** An incident to open and the memory that mirrors it into recall, built as `ObjectSave` has it. */
export interface IncidentOpen {
  readonly mirror: MemoryEntry;
  readonly fields: IncidentFields;
  readonly actor: string;
  readonly at: string;
}

/** Why an incident was not opened: `memoryId` is the first linked id, in the order given, that
 * is no memory of the tenant; or the written row could not be read back. */
export type IncidentOpenRefusal =
  | { readonly refused: 'unlinked'; readonly memoryId: string }
  | { readonly refused: 'vanished' };

/** Why a save wrote nothing: any `ObjectRefusal`, or `memoryId`, the memory the save named to
 * weaken, is no memory of the tenant. */
export type SaveRefusal =
  | ObjectRefusal
  | { readonly refused: 'memory_missing'; readonly memoryId: string };

export interface IncidentResolve {
  readonly text: string;
  readonly actor: string;
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
  listObjects<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    query: ObjectListQuery<K>,
  ): Promise<ObjectByKind[K][]>;
  listObjects(tenantId: string, kind: 'policy', query: PoliciesInForceQuery): Promise<Policy[]>;
  listObjects(tenantId: string, kind: 'skill', query: SkillsByNameQuery): Promise<Skill[]>;
  listObjects(
    tenantId: string,
    kind: 'prediction',
    query: PredictionListQuery,
  ): Promise<Prediction[]>;
  objectById<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    id: number,
  ): Promise<ObjectByKind[K] | null>;
  objectById(tenantId: string, kind: 'prediction', id: number): Promise<Prediction | null>;
  closeObject<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    id: number,
    close: ObjectClose<K>,
  ): Promise<ObjectByKind[K] | ObjectRefusal>;
  closeObject(
    tenantId: string,
    kind: 'incident',
    id: number,
    resolve: IncidentResolve,
  ): Promise<Incident | ObjectRefusal>;
  closeObject(
    tenantId: string,
    kind: 'prediction',
    id: number,
    close: PredictionClose,
  ): Promise<Prediction>;
  saveObject<K extends SavableKind>(
    tenantId: string,
    kind: K,
    save: ObjectSave<K>,
  ): Promise<ObjectByKind[K] | SaveRefusal>;
  saveObject(
    tenantId: string,
    kind: 'incident',
    open: IncidentOpen,
  ): Promise<Incident | IncidentOpenRefusal>;
  saveObject(tenantId: string, kind: 'prediction', save: PredictionSave): Promise<Prediction>;
  briefReceipts(tenantId: string, tag: string, limit: number): Promise<BriefReceipt[]>;
  predictionBaserate(
    tenantId: string,
    classTag: string,
    actor: string,
  ): Promise<PredictionBaserate>;
}

/** What each Objects method does to the store; every adapter honours it. */
export const OBJECTS_EFFECTS = {
  listObjects: 'read',
  objectById: 'read',
  closeObject: 'write',
  saveObject: 'write',
  briefReceipts: 'read',
  predictionBaserate: 'write',
} as const satisfies MethodEffects<Objects>;

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
  saveObject(...args: ObjectSaveArgs): Promise<AnyObject | SaveRefusal | IncidentOpenRefusal>;
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
