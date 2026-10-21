// HTTP replies and the CLI's --json keep snake_case keys, as clients read them; the port's rows are camelCase.
import type { JsonValue } from '../base/util/json.js';
import type { SessionHandoff } from '../base/session/handoff.js';
import type { ContinuityBlock } from '../store/port.js';
import type { SessionEvent, TaskSnapshot } from '../store/port/sessions.js';

export interface TaskSnapshotJson {
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

export interface SessionEventJson {
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

export interface ContinuityBlockJson {
  activeSnapshot: TaskSnapshotJson | null;
  sessionHandoff: SessionHandoff | null;
  recentSessionEvents: SessionEventJson[];
}

export function snapshotJson(s: TaskSnapshot): TaskSnapshotJson {
  return {
    id: s.id,
    task: s.task,
    summary: s.summary,
    next_step: s.nextStep,
    status: s.status,
    source: s.source,
    session_id: s.sessionId,
    scope: s.scope,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function sessionEventJson(e: SessionEvent): SessionEventJson {
  return {
    id: e.id,
    session_id: e.sessionId,
    task: e.task,
    event_type: e.eventType,
    content: e.content,
    source: e.source,
    scope: e.scope,
    metadata: e.metadata,
    created_at: e.createdAt,
  };
}

export function continuityJson(block: ContinuityBlock): ContinuityBlockJson {
  return {
    activeSnapshot: block.activeSnapshot === null ? null : snapshotJson(block.activeSnapshot),
    sessionHandoff: block.sessionHandoff,
    recentSessionEvents: block.recentSessionEvents.map(sessionEventJson),
  };
}
