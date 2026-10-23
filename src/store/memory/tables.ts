// The rows an in-memory store holds: plain tables its caller owns, as whoever opens a store folder owns it. Every
// group of memoryStore reads and writes these, so a write through one group shows in the reads of every other.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { PhysicsParticle } from '../../base/rank/physics.js';
import type { ObjectByKind, ObjectKind } from '../../base/records/object-types.js';
import type { ConnectorDeadLetter, ConnectorEvent, SlackWorkspace, StoredCursors } from '../port/connectors.js';
import type { Entity, Relation } from '../port/graph.js';
import type { NewApiKey } from '../port/keys.js';
import type { FailureOutcome, RoutineRule, RejectedValueRow } from '../port/rejections.js';
import type { Prediction } from '../port/objects.js';
import type { QuarantineRow } from '../port/quarantine.js';
import type { AuditEvent } from '../port/types.js';
import { emptySessionTables, type SessionTables } from './session-tables.js';

/** One api key; a stored role stays as written, since findApiKey returns it raw and only a list reads it. */
export interface KeyRow extends Omit<NewApiKey, 'role'> {
  readonly id: number;
  readonly role: string;
  readonly revokedAt: string | null;
  readonly scopes: readonly string[];
}

interface StoredVector {
  readonly model: string;
  readonly bytes: Uint8Array;
}

export interface LoggedFailure {
  readonly id: number;
  readonly ts: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly tool: string | null;
  outcome: FailureOutcome;
  readonly rule: RoutineRule | null;
  readonly sigHash: string | null;
  readonly detailHash: string | null;
  readonly ownerSubject: string | null;
  readonly originProject: string | null;
  readonly requestId: string | null;
}

export interface CompactionRecord {
  readonly tenantId: string;
  readonly id: string;
  readonly sessionId: string;
  readonly originProject: string;
  readonly startedAt: string;
  snapshotSaved: boolean;
  status: string;
  items: string[];
  itemsWritten: number;
  requestId: string | null;
}

/** One connector event log row; the delivery id and event name are GitHub's and null for Slack. */
export interface LoggedEvent {
  readonly connector: ConnectorEvent['connector'];
  readonly eventKey: string;
  readonly memoryId: string | null;
  readonly deliveryId: string | null;
  readonly eventName: string | null;
  readonly loggedAt: string;
}

/** One dead-letter row of either queue; the columns only the other connector's queue has are null. */
export interface ParkedLetter {
  readonly connector: ConnectorDeadLetter['connector'];
  readonly id: number;
  readonly tenantId: string;
  readonly rawPayload: string;
  readonly error: string;
  readonly bucket: string;
  readonly signature: string | null;
  readonly receivedAt: string;
  readonly teamId: string | null;
  readonly slackTimestamp: string | null;
  readonly eventName: string | null;
  readonly deliveryId: string | null;
  readonly installationId: string | null;
  readonly repoFullName: string | null;
  readonly retryCount: number;
  readonly retriedAt: string | null;
}

export interface RepoRoute {
  readonly repoFullName: string;
  readonly tenantId: string;
  readonly addedAt: string;
}

export interface ArchivedRow {
  readonly memoryId: string;
  readonly archivedAt: string;
  readonly reason: string;
  readonly archivedBy: string;
}

export interface SleepRun {
  readonly timestamp: string;
  readonly decayed: number;
  readonly merged: number;
  readonly removed: number;
}

type ObjectTables = { readonly [K in ObjectKind]: Map<number, ObjectByKind[K]> };

export interface MemoryTables extends SessionTables {
  /** Every tenant's memories by id, in insertion order, the tie-break order a read falls back to. */
  entries: Map<string, MemoryEntry>;
  /** memories.updated_at by id, as datetime('now') stamped it; recall's match tiers order by it. */
  readonly updatedAt: Map<string, string>;
  /** Tombstones by tenantKey(tenant, digest). */
  readonly rejected: Map<string, RejectedValueRow>;
  readonly rawArchive: ArchivedRow[];
  readonly audit: AuditEvent[];
  /** The highest id each table has handed out; a deleted id is never reused. */
  readonly seq: Map<string, number>;
  readonly keys: Map<string, KeyRow>;
  /** Store-wide counters and settings by name: total_remembered, total_recalled, total_forgotten, embedding_model. */
  readonly meta: Map<string, string>;
  readonly vectors: Map<string, StoredVector>;
  readonly particles: Map<string, PhysicsParticle>;
  failures: LoggedFailure[];
  readonly compactions: CompactionRecord[];
  /** Connector event log rows by eventSlot(connector, key). */
  readonly connectorLog: Map<string, LoggedEvent>;
  readonly quarantine: QuarantineRow[];
  readonly deadLetters: ParkedLetter[];
  readonly slackWorkspaces: Map<string, SlackWorkspace>;
  /** Latest timestamps by tenant and channel. */
  readonly slackCursors: Map<string, string>;
  readonly githubCursors: Map<string, StoredCursors>;
  /** Tenant by installation id. */
  readonly githubInstallations: Map<string, string>;
  /** Oldest first, then by tenant. */
  readonly githubRepositories: RepoRoute[];
  /** Expiry in ms by connector and delivery key. */
  readonly deliveryClaims: Map<string, number>;
  readonly objects: ObjectTables;
  readonly predictions: Map<number, Prediction>;
  readonly entities: Entity[];
  readonly relations: Relation[];
  /** Oldest first by timestamp, then id. */
  readonly sleepRuns: SleepRun[];
}

function emptyObjectTables(): ObjectTables {
  return {
    decision: new Map(),
    incident: new Map(),
    process: new Map(),
    policy: new Map(),
    skill: new Map(),
    project_brief: new Map(),
    customer_note: new Map(),
  };
}

/** A store with no rows; the counters start at zero. */
export function emptyTables(): MemoryTables {
  return {
    entries: new Map(),
    updatedAt: new Map(),
    rejected: new Map(),
    rawArchive: [],
    audit: [],
    seq: new Map(),
    keys: new Map(),
    meta: new Map(),
    vectors: new Map(),
    particles: new Map(),
    failures: [],
    compactions: [],
    connectorLog: new Map(),
    quarantine: [],
    deadLetters: [],
    slackWorkspaces: new Map(),
    slackCursors: new Map(),
    githubCursors: new Map(),
    githubInstallations: new Map(),
    githubRepositories: [],
    deliveryClaims: new Map(),
    objects: emptyObjectTables(),
    predictions: new Map(),
    entities: [],
    relations: [],
    sleepRuns: [],
    ...emptySessionTables(),
  };
}
