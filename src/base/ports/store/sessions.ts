// The session, snapshot and handoff shapes the Sessions group takes and returns.
import type { JsonValue, JsonObject } from '../../util/json.js';
import type { HandoffEvidence, HandoffOutcome, SessionHandoff } from '../../session/handoff.js';
import type { ContinuityKey } from './types.js';

export interface TaskSnapshot {
  id: number;
  task: string;
  summary: string;
  nextStep: string;
  status: string;
  source: string;
  sessionId: string | null;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  task: string | null;
  eventType: string;
  content: string;
  source: string;
  scope: string | null;
  metadata: Record<string, JsonValue>;
  createdAt: string;
}

export type SnapshotInput = {
  task: string;
  summary: string;
  nextStep: string;
  source?: string;
  sessionId?: string | null;
  scope?: string | null;
};

export interface SessionEventInput {
  sessionId: string;
  eventType: string;
  content: string;
  task?: string | null;
  source?: string;
  scope?: string | null;
  metadata?: JsonObject;
}

export interface HandoffFilter {
  unfinishedOnly?: boolean;
  maxAgeMs?: number;
  scopeFilter?: 'default-deny';
  excludeSessionId?: string;
}

/** A session end to write as a handoff: from the key's active snapshot, else from `derived` transcript state; `inPlace`
 * rewrites an earlier transcript read instead of adding a revision. */
export interface SessionEndHandoffRequest {
  readonly sessionId: string;
  readonly evidence: HandoffEvidence | null;
  readonly derived?: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'> | null;
  readonly inPlace?: boolean;
}

/** A whole handoff to add as the session's newest revision, or a session end the store builds one from. */
export type HandoffSave =
  | { readonly handoff: Omit<SessionHandoff, 'updatedAt'> }
  | { readonly sessionEnd: SessionEndHandoffRequest };

/** An outcome for the session's newest handoff. */
export interface HandoffStamp {
  readonly sessionId: string;
  readonly outcome: HandoffOutcome;
}

/** One handoff by its row id, or the newest a session id (null: any session) and the filter admit. */
export type HandoffQuery = { readonly id: number } | (HandoffFilter & { readonly sessionId: string | null });

export interface SessionEventQuery {
  readonly sessionId?: string;
  readonly task?: string;
  readonly limit?: number;
}

/** `ambient` reads for a surface other than the snapshot's owner, so an orphaned snapshot expires there. */
export interface SnapshotLoad {
  readonly ambient?: { readonly maxAgeMs?: number; readonly sessionId?: string | null };
}

export interface WorkingMemoryItem {
  id: number;
  scope: string;
  sessionId: string | null;
  taskId: string | null;
  importance: number;
  content: string;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface WorkingMemoryFilter {
  readonly scope?: string;
  readonly sessionId?: string;
}

export interface WorkingMemoryPush {
  readonly scope: string;
  readonly content: string;
  readonly importance?: number;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly metadata?: JsonObject;
}

/** Snapshots, session events, handoffs, working memory and session-owner binding: one save, read and clear for every
 * kind. Every keyed call takes `key: ContinuityKey | null`, so an unkeyed caller says so. */
export interface Sessions {
  /** Saves the active snapshot, superseding the key's earlier active ones. */
  save(tenantId: string, kind: 'snapshot', snapshot: SnapshotInput, key: ContinuityKey | null): Promise<TaskSnapshot>;
  save(tenantId: string, kind: 'event', event: SessionEventInput): Promise<SessionEvent>;
  /** Adds the handoff as the session's newest revision. */
  save(
    tenantId: string,
    kind: 'handoff',
    save: { readonly handoff: Omit<SessionHandoff, 'updatedAt'> },
    key: ContinuityKey | null,
  ): Promise<SessionHandoff>;
  /** The session-end handoff written; null when no source is the session's, a newer handoff covers it, or the latest
   * one is not transcript-derived or already holds `derived`. */
  save(
    tenantId: string,
    kind: 'handoff',
    save: { readonly sessionEnd: SessionEndHandoffRequest },
    key: ContinuityKey | null,
  ): Promise<SessionHandoff | null>;
  /** Stamps the session's newest handoff only while it has no outcome; rows stamped. */
  save(tenantId: string, kind: 'handoff', stamp: HandoffStamp): Promise<number>;
  /** The new item's id. */
  save(tenantId: string, kind: 'working_memory', item: WorkingMemoryPush): Promise<number>;
  /** The `limit` newest events a non-empty session id and task narrow, returned oldest first. */
  read(tenantId: string, kind: 'event', query: SessionEventQuery): Promise<SessionEvent[]>;
  read(tenantId: string, kind: 'handoff', query: { readonly id: number }): Promise<SessionHandoff | null>;
  read(
    tenantId: string,
    kind: 'handoff',
    query: HandoffFilter & { readonly sessionId: string | null },
    key: ContinuityKey | null,
  ): Promise<SessionHandoff | null>;
  read(
    tenantId: string,
    kind: 'working_memory',
    query: WorkingMemoryFilter & { readonly limit?: number },
  ): Promise<WorkingMemoryItem[]>;
  /** Closes with `status` the key's active snapshots the session saved, never a newer session's; rows closed. */
  clear(
    tenantId: string,
    kind: 'snapshot',
    close: { readonly status: string; readonly sessionId: string },
    key: ContinuityKey | null,
  ): Promise<number>;
  /** Closes with `status` the tenant's newest active snapshot, whoever saved it, and drops its mirror; a shared store
   * refuses. Rows closed. */
  clear(tenantId: string, kind: 'snapshot', close: { readonly status: string }): Promise<number>;
  /** Rows cleared; a session-end flush is the same call. */
  clear(tenantId: string, kind: 'working_memory', filter: WorkingMemoryFilter): Promise<number>;
  /** The key's newest active snapshot. It rewrites the active-task mirror, so it is a write, apart from `read`. */
  loadSnapshot(tenantId: string, load: SnapshotLoad, key: ContinuityKey | null): Promise<TaskSnapshot | null>;
  /** The stored owner, which is not `owner` when a concurrent first bind won. */
  bindSessionOwner(tenantId: string, sessionId: string, owner: string, retentionMs: number): Promise<string | null>;
}

/** Each method's overloads as one argument list, so an adapter writes one body per method. */
export type SessionSaveArgs =
  | [tenantId: string, kind: 'snapshot', snapshot: SnapshotInput, key: ContinuityKey | null]
  | [tenantId: string, kind: 'event', event: SessionEventInput]
  | [tenantId: string, kind: 'handoff', save: HandoffSave | HandoffStamp, key?: ContinuityKey | null]
  | [tenantId: string, kind: 'working_memory', item: WorkingMemoryPush];
export type SessionReadArgs =
  | [tenantId: string, kind: 'event', query: SessionEventQuery]
  | [tenantId: string, kind: 'handoff', query: HandoffQuery, key?: ContinuityKey | null]
  | [tenantId: string, kind: 'working_memory', query: WorkingMemoryFilter & { readonly limit?: number }];
export type SessionClearArgs =
  | [
      tenantId: string,
      kind: 'snapshot',
      close: { readonly status: string; readonly sessionId?: string },
      key?: ContinuityKey | null,
    ]
  | [tenantId: string, kind: 'working_memory', filter: WorkingMemoryFilter];

/** `Sessions` as an adapter writes it, one signature per method; the overloads pair each kind with its answer. */
export interface SessionCalls {
  save(...args: SessionSaveArgs): Promise<TaskSnapshot | SessionEvent | SessionHandoff | number | null>;
  read(...args: SessionReadArgs): Promise<SessionEvent[] | SessionHandoff | WorkingMemoryItem[] | null>;
  clear(...args: SessionClearArgs): Promise<number>;
  loadSnapshot: Sessions['loadSnapshot'];
  bindSessionOwner: Sessions['bindSessionOwner'];
}
