/**
 * Session handoff types and helpers.
 *
 * A handoff captures the state of a session so that a successor
 * session (or a different agent) can pick up where the previous
 * one left off.
 */

import { isJsonString, type JsonValue } from './json.js';
import { warnDamagedColumn } from './util/stored-json.js';

/** Terminal state of a handoff's session, denormalized from its `session_complete` event. */
export type HandoffOutcome = 'success' | 'failure' | 'partial';

/** Best-effort evidence of repo state at handoff time; null fields mean collection failed or was skipped. */
export interface HandoffEvidence {
  gitRef?: string | null;
  dirtyTree?: boolean | null;
  testStatus?: 'pass' | 'fail' | 'unknown' | null;
  /** 'transcript' when hippo read the handoff off the session's transcript at session end; a later exit may replace it. */
  derivedFrom?: 'transcript';
}

/** Narrows an unvalidated value (e.g. CLI input or event content) to a HandoffOutcome. */
export function isHandoffOutcome(v: string | boolean | string[] | null | undefined): v is HandoffOutcome {
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

const TEST_STATUSES: ReadonlySet<JsonValue> = new Set(['pass', 'fail', 'unknown']);

const absent = (v: JsonValue | undefined): v is null | undefined => v === undefined || v === null;

function isHandoffEvidence(v: JsonValue): v is JsonValue & HandoffEvidence {
  if (!(v instanceof Object) || Array.isArray(v)) return false;
  const { gitRef, dirtyTree, testStatus, derivedFrom } = v;
  return (absent(gitRef) || isJsonString(gitRef))
    && (absent(dirtyTree) || dirtyTree === true || dirtyTree === false)
    && (absent(testStatus) || TEST_STATUSES.has(testStatus))
    && (derivedFrom === undefined || derivedFrom === 'transcript');
}

/** A stored list column as strings; a damaged one logs and reads as empty instead of hiding the whole handoff. */
function storedList(row: SessionHandoffRow, column: 'artifacts_json' | 'constraints_json'): string[] {
  const raw = row[column];
  if (!raw) return [];
  try {
    const parsed: JsonValue = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    warnDamagedColumn({ table: 'session_handoffs', id: row.id, column }, 'not valid JSON');
    return [];
  }
}

/** Stored evidence, or null (after a log line) when the column is damaged or holds another shape. */
function storedEvidence(row: SessionHandoffRow): HandoffEvidence | null {
  if (!row.evidence_json) return null;
  const site = { table: 'session_handoffs', id: row.id, column: 'evidence_json' };
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(row.evidence_json);
  } catch {
    warnDamagedColumn(site, 'not valid JSON');
    return null;
  }
  if (parsed === null) return null;
  if (isHandoffEvidence(parsed)) return parsed;
  warnDamagedColumn(site, 'wrong shape');
  return null;
}

export function rowToSessionHandoff(row: SessionHandoffRow): SessionHandoff {
  const artifacts = storedList(row, 'artifacts_json');
  const constraints = storedList(row, 'constraints_json');
  const evidence = storedEvidence(row);

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
