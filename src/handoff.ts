/**
 * Session handoff types and helpers.
 *
 * A handoff captures the state of a session so that a successor
 * session (or a different agent) can pick up where the previous
 * one left off.
 */

export interface SessionHandoff {
  version: 1;
  sessionId: string;
  repoRoot?: string;
  taskId?: string;
  summary: string;
  nextAction?: string;
  artifacts?: string[];
  scope?: string | null;
  updatedAt: string;
}

export interface SessionHandoffRow {
  id: number;
  session_id: string;
  repo_root: string | null;
  task_id: string | null;
  summary: string;
  next_action: string | null;
  artifacts_json: string;
  scope: string | null;
  created_at: string;
}

export function rowToSessionHandoff(row: SessionHandoffRow): SessionHandoff {
  let artifacts: string[] = [];
  try {
    const parsed = JSON.parse(row.artifacts_json);
    if (Array.isArray(parsed)) {
      artifacts = parsed.map((item) => String(item));
    }
  } catch {
    artifacts = [];
  }

  return {
    version: 1,
    sessionId: row.session_id,
    repoRoot: row.repo_root ?? undefined,
    taskId: row.task_id ?? undefined,
    summary: row.summary,
    nextAction: row.next_action ?? undefined,
    artifacts,
    scope: row.scope ?? null,
    updatedAt: row.created_at,
  };
}
