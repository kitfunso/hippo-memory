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
} from '../../core/object-types.js';
import type { KeysetPosition } from '../../util/keyset.js';
import type { MemoryEntry } from '../../core/memory.js';

/** Which of a tenant's rows of one kind a list reads: every status when `status` is
 * unset, every value of the kind's one filter column (customer, repo) when `filter`
 * is. Neither is ever empty; a kind with no filter column ignores `filter`. */
export interface ObjectListQuery<K extends ObjectKind = ObjectKind> {
  readonly status?: ObjectByKind[K]['status'];
  readonly filter?: string;
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
  /** The new row's createdAt and the replaced row's supersededAt: core's clock, as `toISOString` gives it, since the
   * list orders createdAt as text. */
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

/** Why an incident was not opened: `memoryId` is the first linked id, in the order
 * given, that is no memory of the tenant; or the written row could not be read back. */
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

/** `asOf` is an instant as `toISOString` gives it, so it compares as text against validFrom and validTo; `name` keeps
 * one policyName, and may be empty. */
export interface PoliciesInForceQuery {
  readonly asOf: string;
  readonly name?: string;
  readonly limit: number;
}

/** The reads and writes behind the typed-object routes. An audit row names the
 * object under the kind's id key (decision_id, incident_id, ...). A row
 * belongs to one tenant: another tenant's id reads as missing in every method. */
export interface Objects {
  /** At most `limit` rows of the kind, newest first: by createdAt compared as text
   * in byte order, then by id, both descending, so the order is total. `after`
   * keeps only the rows below its (createdAt, id) pair in that order. No audit row. */
  listObjects<K extends ObjectKind>(tenantId: string, kind: K, query: ObjectListQuery<K>): Promise<ObjectByKind[K][]>;
  /** The tenant's row; null for a missing id or another tenant's. No audit row. */
  objectById<K extends ObjectKind>(tenantId: string, kind: K, id: number): Promise<ObjectByKind[K] | null>;
  /** In one transaction: moves the tenant's row from a `close.from` status to closed at `close.at` and appends one
   * <kind>_close row; a refusal writes nothing. After the commit a kind the graph reads has its graph rows dropped and
   * its mirror queued for a rebuild; a failure there is logged, never thrown. */
  closeObject<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    id: number,
    close: ObjectClose<K>,
  ): Promise<ObjectByKind[K] | ObjectRefusal>;
  /** In one transaction, in order: writes `mirror` as `EntryWrites.writeEntry` does; inserts the row active (version 1,
   * or the replaced row's plus one); with `supersedesId`, supersedes that row; appends the supersede and create rows. A
   * refusal (`missing`, `status`, `raced`, `vanished`) writes nothing. */
  saveObject<K extends SavableKind>(
    tenantId: string,
    kind: K,
    save: ObjectSave<K>,
  ): Promise<ObjectByKind[K] | ObjectRefusal>;
  /** In one transaction, in order: writes `mirror` as `EntryWrites.writeEntry` does; checks each linked id is a memory
   * of the tenant; inserts the row open under the next id; appends the incident_open row, then the mirror's remember
   * row. A refusal leaves no mirror, row or audit row. */
  openIncident(tenantId: string, open: IncidentOpen): Promise<Incident | IncidentOpenRefusal>;
  /** In one transaction: moves the tenant's incident from open to resolved with `resolve.text` and `resolve.at`, then
   * appends one incident_resolve row. A refusal (`missing`, `status`, or `vanished`) writes nothing. */
  resolveIncident(tenantId: string, id: number, resolve: IncidentResolve): Promise<Incident | ObjectRefusal>;
  /** Policies in force at `asOf` (max `limit`): not closed, validFrom <= asOf < validTo (or unset), and active or
   * superseded by a row whose validFrom is after asOf. Newest validFrom first, compared as text in byte order, then
   * larger id. No audit row. */
  policiesInForce(tenantId: string, query: PoliciesInForceQuery): Promise<Policy[]>;
  /** At most `limit` of the tenant's active skills, by skillName ascending compared as text in byte order, then by id
   * ascending. No audit row. */
  activeSkillsByName(tenantId: string, limit: number): Promise<Skill[]>;
  /** At most `limit` of the tenant's memories carrying `tag` (tag list as JSON, matched between double quotes,
   * unescaped, ASCII case-folded) whose source is not project_brief and whose scope recall admits with no scope asked,
   * newest first by created (text, byte order) then id. No audit row. */
  briefReceipts(tenantId: string, tag: string, limit: number): Promise<BriefReceipt[]>;
  /** The id of the tenant's newest `kind` row in `status` that `memoryId` mirrors, or null. No audit row. */
  objectIdByMemory<K extends ObjectKind>(
    tenantId: string,
    kind: K,
    status: ObjectByKind[K]['status'],
    memoryId: string,
  ): Promise<number | null>;
}
