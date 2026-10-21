// The session, snapshot and handoff shapes the Sessions group takes and returns.
import type { JsonValue, JsonObject } from '../../base/util/json.js';
import type { HandoffEvidence, HandoffOutcome, SessionHandoff } from '../../base/session/handoff.js';
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

export interface SessionEndHandoffRequest {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly evidence: HandoffEvidence | null;
  readonly derived?: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'> | null;
  readonly key?: ContinuityKey;
  readonly inPlace?: boolean;
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

/** Snapshots, session events, handoffs, working memory and session-owner binding. Every keyed method takes `key:
 * ContinuityKey | null`, since a group cannot gain members once it ships. */
export interface Sessions {
  saveSnapshot(tenantId: string, snapshot: SnapshotInput, key: ContinuityKey | null): Promise<TaskSnapshot>;
  loadSnapshot(tenantId: string, key: ContinuityKey | null): Promise<TaskSnapshot | null>;
  loadFreshSnapshot(
    tenantId: string,
    opts: { readonly maxAgeMs?: number; readonly sessionId?: string | null },
    key: ContinuityKey | null,
  ): Promise<TaskSnapshot | null>;
  /** True when an active snapshot was cleared. */
  clearSnapshot(tenantId: string, clearedStatus: string): Promise<boolean>;
  /** Rows closed. */
  closeSessionSnapshots(
    tenantId: string,
    sessionId: string,
    status: string,
    key: ContinuityKey | null,
  ): Promise<number>;
  appendEvent(tenantId: string, event: SessionEventInput): Promise<SessionEvent>;
  listEvents(
    tenantId: string,
    opts: { readonly sessionId?: string; readonly task?: string; readonly limit?: number },
  ): Promise<SessionEvent[]>;
  saveHandoff(
    tenantId: string,
    handoff: Omit<SessionHandoff, 'updatedAt'>,
    key: ContinuityKey | null,
  ): Promise<SessionHandoff>;
  latestHandoff(
    tenantId: string,
    sessionId: string | null,
    filter: HandoffFilter,
    key: ContinuityKey | null,
  ): Promise<SessionHandoff | null>;
  handoffById(tenantId: string, id: number): Promise<SessionHandoff | null>;
  /** Rows stamped. */
  stampHandoffOutcome(tenantId: string, sessionId: string, outcome: HandoffOutcome): Promise<number>;
  writeSessionEndHandoff(
    tenantId: string,
    request: Omit<SessionEndHandoffRequest, 'tenantId'>,
  ): Promise<SessionHandoff | null>;
  pushWorkingMemory(tenantId: string, item: WorkingMemoryPush): Promise<number>;
  readWorkingMemory(
    tenantId: string,
    filter: WorkingMemoryFilter & { readonly limit?: number },
  ): Promise<WorkingMemoryItem[]>;
  /** Rows cleared; a session-end flush is the same call. */
  clearWorkingMemory(tenantId: string, filter: WorkingMemoryFilter): Promise<number>;
  /** The stored owner, which is not `owner` when a concurrent first bind won. */
  bindSessionOwner(tenantId: string, sessionId: string, owner: string, retentionMs: number): Promise<string | null>;
}
