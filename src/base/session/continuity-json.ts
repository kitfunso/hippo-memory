// HTTP replies and the CLI's --json keep snake_case keys, as clients read them; the port's rows are
// camelCase. Each wire type is its serializer's return, so the keys are written once.
import type { ContinuityBlock } from '../ports/store.js';
import type { SessionEvent, TaskSnapshot } from '../records/sessions.js';

export function snapshotJson(s: TaskSnapshot) {
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

// SAFETY: hippo.db's task_snapshots rows carry these keys; scripts/checks/check-row-casts.mjs proves
// each read cast to this type selects them.
export type TaskSnapshotJson = ReturnType<typeof snapshotJson>;

export function sessionEventJson(e: SessionEvent) {
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

export function continuityJson(block: ContinuityBlock) {
  return {
    activeSnapshot: block.activeSnapshot === null ? null : snapshotJson(block.activeSnapshot),
    sessionHandoff: block.sessionHandoff,
    recentSessionEvents: block.recentSessionEvents.map(sessionEventJson),
  };
}

export type ContinuityBlockJson = ReturnType<typeof continuityJson>;
