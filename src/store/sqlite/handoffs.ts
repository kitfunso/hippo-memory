import { type DatabaseSyncLike } from '../../db/index.js';
import {
  type SessionHandoff,
  type SessionHandoffRow,
  rowToSessionHandoff,
  type HandoffOutcome,
  isHandoffOutcome,
} from '../../base/session/handoff.js';
import { scopeAdmitSql } from './rule-sql.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { StoreFiles } from './open.js';
import { continuityWhere, loadActiveTaskSnapshot } from './task-snapshots.js';
import { continuityStamp, type ContinuityKey, type ContinuityStamp } from '../port/types.js';
import type { HandoffFilter, SessionEndHandoffRequest } from '../port/sessions.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { sessionEndHandoff, sessionEndSource } from '../rules/session-end.js';

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

/** Session-end handoff from the active snapshot, else `derived` transcript state; `inPlace` rewrites an earlier
 * transcript read instead of adding a revision. Returns null when no source is the session's, a newer handoff covers
 * it, or the latest one is not transcript-derived or already holds `derived`. */
export function writeSessionEndHandoff(
  db: DatabaseSyncLike,
  files: StoreFiles,
  tenantId: string,
  request: Omit<SessionEndHandoffRequest, 'tenantId'>,
): SessionHandoff | null {
  const { sessionId, key, inPlace } = request;
  assertTenantId('writeSessionEndHandoff', tenantId);
  if (key) continuityStamp(key); // a partial key is a caller bug, so fail loud rather than write nothing
  const active = loadActiveTaskSnapshot(db, files, tenantId, key);
  const existing = loadLatestHandoff(db, tenantId, sessionId, {}, key);
  const source = sessionEndSource(active, existing, request);
  if (!source) return null;
  const handoff = sessionEndHandoff(sessionId, source, existing, sessionOutcome(db, tenantId, sessionId));
  // A miss means a handoff landed since the read, and a new transcript row would hide it.
  if (source.fromTranscript && inPlace && existing) return replaceTranscriptHandoff(db, tenantId, handoff, key);
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
