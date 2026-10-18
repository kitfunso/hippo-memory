// The session, snapshot and handoff shapes the Sessions group takes and returns.
import type { JsonValue } from '../../util/json.js';
import type { JsonObject } from './types.js';
import type { HandoffEvidence } from '../../core/handoff.js';
import type { ContinuityKey } from './types.js';

export interface TaskSnapshot {
  id: number;
  task: string;
  summary: string;
  next_step: string;
  status: string;
  source: string;
  session_id: string | null;
  scope: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionEvent {
  id: number;
  session_id: string;
  task: string | null;
  event_type: string;
  content: string;
  source: string;
  scope: string | null;
  metadata: Record<string, JsonValue>;
  created_at: string;
}

export type SnapshotInput = {
  task: string;
  summary: string;
  next_step: string;
  source?: string;
  session_id?: string | null;
  scope?: string | null;
};

export interface SessionEventInput {
  session_id: string;
  event_type: string;
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
  readonly derived?: Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'> | null;
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
