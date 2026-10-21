import { type DatabaseSyncLike } from '../../db/index.js';
import {
  type SessionHandoff,
  type SessionHandoffRow,
  rowToSessionHandoff,
  type HandoffOutcome,
  type HandoffEvidence,
  isHandoffOutcome,
} from '../../base/session/handoff.js';
import { scopeAdmitSql } from './rule-sql.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { TaskSnapshot } from '../port/sessions.js';
import type { StoreFiles } from './open.js';
import { continuityWhere, loadActiveTaskSnapshot } from './task-snapshots.js';
import { continuityStamp, type ContinuityKey, type ContinuityStamp } from '../port/types.js';
import type { HandoffFilter, SessionEndHandoffRequest } from '../port/sessions.js';
import { cachedStatement } from '../../db/statement-cache.js';

/** Column list shared by every session_handoffs SELECT; cards.ts reuses it for the card handoff lookup. */
export const HANDOFF_COLUMNS =
  'id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at, constraints_json, ' +
  'evidence_json, outcome, target_runtime, card_id';
// SAFETY: every read cast to this row selects HANDOFF_COLUMNS; scripts/check-row-casts.mjs proves it.
export type SessionHandoffDbRow = SessionHandoffRow;

function insertHandoffRow(
  db: DatabaseSyncLike,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  stamp: ContinuityStamp | null,
  now: string,
) {
  return cachedStatement(
    db,
    `\n      INSERT INTO session_handoffs(session_id, repo_root, task_id, summary, next_action, artifacts_json, ` +
      `scope, tenant_id, created_at, ` +
      `constraints_json, evidence_json, outcome, target_runtime, card_id, owner_subject, origin_project)\n` +
      `      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n    `,
  ).run(
    handoff.sessionId,
    handoff.repoRoot ?? null,
    handoff.taskId ?? null,
    handoff.summary,
    handoff.nextAction ?? null,
    JSON.stringify(handoff.artifacts ?? []),
    handoff.scope ?? null,
    tenantId,
    now,
    JSON.stringify(handoff.constraints ?? []),
    handoff.evidence ? JSON.stringify(handoff.evidence) : null,
    handoff.outcome ?? null,
    handoff.targetRuntime ?? null,
    handoff.cardId ?? null,
    stamp?.owner ?? null,
    stamp?.origin ?? null,
  );
}

/** Save a session handoff record; returns the persisted handoff. */
export function saveSessionHandoff(
  db: DatabaseSyncLike,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  key?: ContinuityKey | null,
): SessionHandoff {
  assertTenantId('saveSessionHandoff', tenantId);
  const stamp = key ? continuityStamp(key) : null;
  const now = new Date().toISOString();

  // Scope is stored as given, since reads deny by default.
  // api.recall and printRecall continuity exclude slack:private:* and 'unknown:legacy'.
  const result = insertHandoffRow(db, tenantId, handoff, stamp, now);

  const id = Number(result.lastInsertRowid ?? 0);
  const row = cachedStatement(db, `SELECT ${HANDOFF_COLUMNS} FROM session_handoffs WHERE id = ?`).get(id) as
    | SessionHandoffDbRow
    | undefined;
  if (!row) {
    throw new Error('Failed to reload saved session handoff');
  }

  return rowToSessionHandoff(row);
}

function handoffConditions(
  tenantId: string,
  sessionId: string | null | undefined,
  opts: HandoffFilter,
  key: ContinuityKey | null | undefined,
) {
  const owned = key ? continuityWhere(key) : null;
  const conditions: string[] = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (owned) {
    conditions.push(owned.sql);
    params.push(...owned.params);
  }
  if (sessionId) {
    conditions.push('session_id = ?');
    params.push(sessionId);
  }
  if (opts.excludeSessionId) {
    conditions.push('session_id != ?');
    params.push(opts.excludeSessionId);
  }
  if (opts.unfinishedOnly) {
    // Restrict to each session's newest revision first: stampHandoffOutcome only stamps the newest row, so an older
    // null-outcome revision must not resurrect. Keyed, the newest is the owner's own, so another owner's newer revision
    // cannot hide it.
    conditions.push(
      `id IN (SELECT MAX(id) FROM session_handoffs WHERE tenant_id = ?${owned ? ` AND ${owned.sql}` : ''} GROUP BY ` +
        `session_id)`,
    );
    params.push(tenantId, ...(owned?.params ?? []));
    conditions.push(`(outcome IS NULL OR outcome IN ('partial','failure'))`);
  }
  if (opts.maxAgeMs != null) {
    conditions.push('created_at >= ?');
    params.push(new Date(Date.now() - opts.maxAgeMs).toISOString());
  }
  if (opts.scopeFilter === 'default-deny') {
    // Admit scope before LIMIT 1, else a newer denied row hides an older eligible one.
    const deny = scopeAdmitSql('');
    conditions.push(deny.sql);
    params.push(...deny.params);
  }
  return { conditions, params };
}

/** Load the most recent handoff, optionally filtered by session ID. */
export function loadLatestHandoff(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId?: string | null,
  opts: HandoffFilter = {},
  key?: ContinuityKey | null,
): SessionHandoff | null {
  assertTenantId('loadLatestHandoff', tenantId);
  const { conditions, params } = handoffConditions(tenantId, sessionId, opts, key);
  const row = cachedStatement(
    db,
    `
    SELECT ${HANDOFF_COLUMNS}
    FROM session_handoffs
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `,
  ).get(...params) as SessionHandoffDbRow | undefined;

  return row ? rowToSessionHandoff(row) : null;
}

/** Load a specific handoff by its row ID. */
export function loadHandoffById(db: DatabaseSyncLike, tenantId: string, id: number): SessionHandoff | null {
  assertTenantId('loadHandoffById', tenantId);
  const row = cachedStatement(
    db,
    `
    SELECT ${HANDOFF_COLUMNS}
    FROM session_handoffs
    WHERE id = ? AND tenant_id = ?
  `,
  ).get(id, tenantId) as SessionHandoffDbRow | undefined;

  return row ? rowToSessionHandoff(row) : null;
}

/** Stamp the outcome on a session's newest handoff, only if it has none yet. Returns rows changed. */
export function stampHandoffOutcome(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  outcome: HandoffOutcome,
): number {
  assertTenantId('stampHandoffOutcome', tenantId);
  const result = cachedStatement(
    db,
    `
  UPDATE session_handoffs SET outcome = ?
  WHERE tenant_id = ? AND session_id = ? AND outcome IS NULL
    AND id = (
      SELECT id FROM session_handoffs
      WHERE tenant_id = ? AND session_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
    `,
  ).run(outcome, tenantId, sessionId, tenantId, sessionId);
  return Number(result.changes ?? 0);
}

/** Rewrites the session's newest handoff when it is still a transcript read, in one statement so a handoff written
 * meanwhile is never overwritten; null when none was rewritten. */
function replaceTranscriptHandoff(
  db: DatabaseSyncLike,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  key: ContinuityKey | null | undefined,
): SessionHandoff | null {
  const { conditions, params } = handoffConditions(tenantId, handoff.sessionId, {}, key);
  const newest =
    `SELECT id FROM session_handoffs WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC, id ` + `DESC LIMIT 1`;
  const result = cachedStatement(
    db,
    `
    UPDATE session_handoffs SET repo_root = ?, task_id = ?, summary = ?, next_action = ?, artifacts_json = ?, scope =
    ?, created_at = ?,
      constraints_json = ?, evidence_json = ?, outcome = ?, target_runtime = ?, card_id = ?
    WHERE id = (${newest}) AND json_valid(evidence_json) AND json_extract(evidence_json, '$.derivedFrom') =
    'transcript'
  `,
  ).run(
    handoff.repoRoot ?? null,
    handoff.taskId ?? null,
    handoff.summary,
    handoff.nextAction ?? null,
    JSON.stringify(handoff.artifacts ?? []),
    handoff.scope ?? null,
    new Date().toISOString(),
    JSON.stringify(handoff.constraints ?? []),
    handoff.evidence ? JSON.stringify(handoff.evidence) : null,
    handoff.outcome ?? null,
    handoff.targetRuntime ?? null,
    handoff.cardId ?? null,
    ...params,
  );
  if (Number(result.changes ?? 0) === 0) return null;
  const row = cachedStatement(db, `SELECT ${HANDOFF_COLUMNS} FROM session_handoffs WHERE id = (${newest})`).get(
    ...params,
  ) as SessionHandoffDbRow | undefined;
  return row ? rowToSessionHandoff(row) : null;
}

interface HandoffSource {
  snapshot: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep' | 'scope'>;
  evidence: HandoffEvidence | null;
}

function transcriptHandoffSource(
  existing: SessionHandoff | null,
  derived: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'> | null,
  evidence: HandoffEvidence | null,
): HandoffSource | null {
  // Only an earlier transcript read gives way; `hippo handoff create` and unmarked older handoffs keep winning.
  if (!derived || (existing && existing.evidence?.derivedFrom !== 'transcript')) return null;
  // A retried session end reads the same transcript, so it must not add a second revision.
  if (
    existing &&
    existing.taskId === derived.task &&
    existing.summary === derived.summary &&
    existing.nextAction === derived.nextStep
  ) {
    return null;
  }
  return { snapshot: { ...derived, scope: null }, evidence: { ...evidence, derivedFrom: 'transcript' } };
}

function buildSessionEndHandoff(
  sessionId: string,
  snapshot: HandoffSource['snapshot'],
  existing: SessionHandoff | null,
  handoffEvidence: HandoffEvidence | null,
  outcome: HandoffOutcome | null,
): Omit<SessionHandoff, 'updatedAt'> {
  // A same-task refresh carries forward envelope fields nobody cleared; a scope mismatch must not leak private metadata
  // into an unscoped envelope.
  const carryForward =
    existing != null && existing.taskId === snapshot.task && (existing.scope ?? null) === (snapshot.scope ?? null);

  return {
    version: 1,
    sessionId,
    repoRoot: carryForward ? existing.repoRoot : undefined,
    taskId: snapshot.task,
    summary: snapshot.summary,
    nextAction: snapshot.nextStep,
    artifacts: carryForward ? existing.artifacts : [],
    scope: snapshot.scope,
    evidence: handoffEvidence,
    outcome,
    constraints: carryForward ? existing.constraints : undefined,
    targetRuntime: carryForward ? existing.targetRuntime : undefined,
    cardId: carryForward ? existing.cardId : undefined,
  };
}

/** Session-end handoff from the active snapshot, else `derived` transcript state; `inPlace` rewrites an earlier
 * transcript read instead of adding a revision. Returns null when no source is the session's, a newer handoff covers
 * it, or the latest one is not transcript-derived or already holds `derived`. */
export function writeSessionEndHandoff(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  request: Omit<SessionEndHandoffRequest, 'tenantId'>,
): SessionHandoff | null {
  const { sessionId, evidence, derived = null, key, inPlace } = request;
  assertTenantId('writeSessionEndHandoff', tenantId);
  if (key) continuityStamp(key); // a partial key is a caller bug, so fail loud rather than write nothing
  const active = loadActiveTaskSnapshot(db, files, tenantId, key);
  const existing = loadLatestHandoff(db, tenantId, sessionId, {}, key);
  let snapshot: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep' | 'scope'>;
  let handoffEvidence = evidence;
  let fromTranscript = false;
  // After every reply the transcript is newer than the last compaction's snapshot, which the open chat keeps for the
  // next one.
  const snapshotGivesWay = inPlace === true && derived !== null && active?.source === 'pre-compact';
  if (active && active.sessionId === sessionId && !snapshotGivesWay) {
    // Strict '>': a same-millisecond tie must not swallow the session's only write (test 6e).
    if (existing && existing.updatedAt > active.updatedAt) return null;
    snapshot = active;
  } else {
    const fromDerived = transcriptHandoffSource(existing, derived, evidence);
    if (!fromDerived) return null;
    snapshot = fromDerived.snapshot;
    handoffEvidence = fromDerived.evidence;
    fromTranscript = true;
  }
  const outcome = sessionOutcome(db, tenantId, sessionId);
  const handoff = buildSessionEndHandoff(sessionId, snapshot, existing, handoffEvidence, outcome);
  // A miss means a handoff landed since the read, and a new transcript row would hide it.
  if (fromTranscript && inPlace && existing) return replaceTranscriptHandoff(db, tenantId, handoff, key);
  return saveSessionHandoff(db, tenantId, handoff, key);
}

function sessionOutcome(db: DatabaseSyncLike, tenantId: string, sessionId: string): HandoffOutcome | null {
  const content = (
    cachedStatement(
      db,
      `
    SELECT content FROM session_events
    WHERE tenant_id = ? AND session_id = ? AND event_type = 'session_complete'
    ORDER BY created_at DESC, id DESC LIMIT 1
  `,
    ).get(tenantId, sessionId) as { content?: string } | undefined
  )?.content;
  return isHandoffOutcome(content) ? content : null;
}
