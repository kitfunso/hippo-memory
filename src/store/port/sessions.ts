// The session, snapshot and handoff shapes the Sessions group takes and returns.
import type { JsonValue, JsonObject } from '../../base/util/json.js';
import type { HandoffEvidence } from '../../base/session/handoff.js';
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
