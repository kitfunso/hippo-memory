/**
 * Session handoff types and helpers.
 *
 * A handoff captures the state of a session so that a successor
 * session (or a different agent) can pick up where the previous
 * one left off.
 */

/** Terminal state of a handoff's session, denormalized from its `session_complete` event. */
export type HandoffOutcome = 'success' | 'failure' | 'partial';

/** Best-effort evidence of repo state at handoff time; null fields mean collection failed or was skipped. */
export interface HandoffEvidence {
  gitRef?: string | null;
  dirtyTree?: boolean | null;
  testStatus?: 'pass' | 'fail' | 'unknown' | null;
}

/** Narrows an unvalidated value (e.g. CLI input or event content) to a HandoffOutcome. */
export function isHandoffOutcome(v: unknown): v is HandoffOutcome {
  return v === 'success' || v === 'failure' || v === 'partial';
}

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
  constraints?: string[];
  evidence?: HandoffEvidence | null;
  outcome?: HandoffOutcome | null;
  targetRuntime?: string | null;
  cardId?: string | null;
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
  constraints_json: string | null;
  evidence_json: string | null;
  outcome: string | null;
  target_runtime: string | null;
  card_id: string | null;
}

/** Renders evidence as one line shared by every renderer (CLI, MCP, token accounting). */
export function formatHandoffEvidenceLine(evidence: HandoffEvidence): string {
  const gitRef = evidence.gitRef ?? 'unknown';
  const tree = evidence.dirtyTree === true ? 'dirty' : evidence.dirtyTree === false ? 'clean' : 'unknown';
  const tests = evidence.testStatus ?? 'unknown';
  return `git ${gitRef}, tree ${tree}, tests ${tests}`;
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

  let constraints: string[] = [];
  try {
    const parsed = row.constraints_json ? JSON.parse(row.constraints_json) : [];
    if (Array.isArray(parsed)) {
      constraints = parsed.map((item) => String(item));
    }
  } catch {
    constraints = [];
  }

  let evidence: HandoffEvidence | null = null;
  try {
    evidence = row.evidence_json ? (JSON.parse(row.evidence_json) as HandoffEvidence) : null;
  } catch {
    evidence = null;
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
    constraints,
    evidence,
    outcome: isHandoffOutcome(row.outcome) ? row.outcome : null,
    targetRuntime: row.target_runtime ?? null,
    cardId: row.card_id ?? null,
  };
}
