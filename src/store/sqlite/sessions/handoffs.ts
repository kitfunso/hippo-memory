import { changedRows, type DatabaseSyncLike } from '../../../db/index.js';
import {
  type SessionHandoff,
  type SessionHandoffRow,
  rowToSessionHandoff,
  type HandoffOutcome,
  isHandoffOutcome,
  type HandoffEvidence,
} from '../../../base/session/handoff.js';
import { scopeAdmitSql } from '../runtime/rule-sql.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import type { StoreFiles } from '../runtime/open.js';
import { continuityWhere, readActiveTaskSnapshot } from './task-snapshots.js';
import {
  continuityStamp,
  type ContinuityKey,
  type ContinuityStamp,
} from '../../../base/ports/store/types.js';
import type {
  HandoffFilter,
  SessionEndHandoffRequest,
  TaskSnapshot,
} from '../../../base/ports/store/sessions.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { handleNow, handleStamp } from '../runtime/handle-clock.js';

// What a session end writes: the snapshot or transcript read it writes from, and the handoff it
// builds; the store loads the rows these read and stores the result.

type Derived = Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'>;

/** The snapshot and evidence a session end writes from. */
interface SessionEndSource {
  readonly snapshot: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep' | 'scope'>;
  readonly evidence: HandoffEvidence | null;
  /** Read from the transcript, so an in-place write may rewrite an earlier transcript read. */
  readonly fromTranscript: boolean;
}

function transcriptSource(
  existing: SessionHandoff | null,
  derived: Derived | null,
  evidence: HandoffEvidence | null,
): SessionEndSource | null {
  // Only an earlier transcript read gives way; `hippo handoff create` and unmarked older handoffs
  // keep winning.
  if (!derived || (existing && existing.evidence?.derivedFrom !== 'transcript')) return null;
  // A retried session end reads the same transcript, so it must not add a second revision.
  const same =
    existing?.taskId === derived.task &&
    existing.summary === derived.summary &&
    existing.nextAction === derived.nextStep;
  if (existing && same) return null;
  const snapshot = { ...derived, scope: null };
  return { snapshot, evidence: { ...evidence, derivedFrom: 'transcript' }, fromTranscript: true };
}

/** The source given the key's active snapshot and the session's newest handoff; null when that
 * handoff already covers the session or no source is the session's. */
function sessionEndSource(
  active: TaskSnapshot | null,
  existing: SessionHandoff | null,
  request: Pick<SessionEndHandoffRequest, 'sessionId' | 'evidence' | 'derived' | 'inPlace'>,
): SessionEndSource | null {
  const { sessionId, evidence, derived = null, inPlace } = request;
  // After every reply the transcript is newer than the last compaction's snapshot, which the open
  // chat keeps for the next one.
  const snapshotGivesWay = inPlace === true && derived !== null && active?.source === 'pre-compact';
  if (active && active.sessionId === sessionId && !snapshotGivesWay) {
    // Strict '>': a same-millisecond tie must not swallow the session's only write.
    if (existing && existing.updatedAt > active.updatedAt) return null;
    return { snapshot: active, evidence, fromTranscript: false };
  }
  return transcriptSource(existing, derived, evidence);
}

/** The handoff `source` writes. A same-task refresh carries forward the envelope fields nobody
 * cleared; a scope mismatch carries none, so private metadata never leaks into an unscoped
 * envelope. */
function sessionEndHandoff(
  sessionId: string,
  source: SessionEndSource,
  existing: SessionHandoff | null,
  outcome: HandoffOutcome | null,
): Omit<SessionHandoff, 'updatedAt'> {
  const { snapshot } = source;
  const carry =
    existing != null &&
    existing.taskId === snapshot.task &&
    (existing.scope ?? null) === (snapshot.scope ?? null);
  return {
    version: 1,
    sessionId,
    repoRoot: carry ? existing.repoRoot : undefined,
    taskId: snapshot.task,
    summary: snapshot.summary,
    nextAction: snapshot.nextStep,
    artifacts: carry ? existing.artifacts : [],
    scope: snapshot.scope,
    evidence: source.evidence,
    outcome,
    constraints: carry ? existing.constraints : undefined,
    targetRuntime: carry ? existing.targetRuntime : undefined,
    cardId: carry ? existing.cardId : undefined,
  };
}

/** Column list shared by every session_handoffs SELECT; cards.ts reuses it for the card handoff
 * lookup. */
export const HANDOFF_COLUMNS =
  'id, session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, created_at, constraints_json, ' +
  'evidence_json, outcome, target_runtime, card_id';
// SAFETY: every read cast to this row selects HANDOFF_COLUMNS; scripts/checks/check-row-casts.mjs proves
// it.
export type SessionHandoffDbRow = SessionHandoffRow;

type HandoffColumn = readonly [column: string, value: string | null];

/** The columns an insert and a transcript rewrite both write, so the two statements cannot drift
 * apart. */
function handoffContentColumns(handoff: Omit<SessionHandoff, 'updatedAt'>): HandoffColumn[] {
  return [
    ['repo_root', handoff.repoRoot ?? null],
    ['task_id', handoff.taskId ?? null],
    ['summary', handoff.summary],
    ['next_action', handoff.nextAction ?? null],
    ['artifacts_json', JSON.stringify(handoff.artifacts ?? [])],
    ['scope', handoff.scope ?? null],
    ['constraints_json', JSON.stringify(handoff.constraints ?? [])],
    ['evidence_json', handoff.evidence ? JSON.stringify(handoff.evidence) : null],
    ['outcome', handoff.outcome ?? null],
    ['target_runtime', handoff.targetRuntime ?? null],
    ['card_id', handoff.cardId ?? null],
  ];
}

interface InsertHandoffRowOptions {
  readonly tenantId: string;
  readonly handoff: Omit<SessionHandoff, 'updatedAt'>;
  readonly stamp: ContinuityStamp | null;
  readonly now: string;
}

function insertHandoffRow(
  db: DatabaseSyncLike,
  { tenantId, handoff, stamp, now }: InsertHandoffRowOptions,
) {
  const columns: HandoffColumn[] = [
    ['session_id', handoff.sessionId],
    ['tenant_id', tenantId],
    ['created_at', now],
    ...handoffContentColumns(handoff),
    ['owner_subject', stamp?.owner ?? null],
    ['origin_project', stamp?.origin ?? null],
  ];
  const names = columns.map(([column]) => column).join(', ');
  const marks = columns.map(() => '?').join(', ');
  return cachedStatement(db, `INSERT INTO session_handoffs(${names}) VALUES (${marks})`).run(
    ...columns.map(([, value]) => value),
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
  const now = handleStamp(db);

  // Scope is stored as given, since reads deny by default.
  // api.recall and printRecall continuity exclude slack:private:* and 'unknown:legacy'.
  const result = insertHandoffRow(db, { tenantId, handoff, stamp, now });

  const id = Number(result.lastInsertRowid ?? 0);
  const row = cachedStatement(
    db,
    `SELECT ${HANDOFF_COLUMNS} FROM session_handoffs WHERE id = ?`,
  ).get(id) as SessionHandoffDbRow | undefined;
  if (!row) {
    throw new Error('Failed to reload saved session handoff');
  }

  return rowToSessionHandoff(row);
}

interface HandoffConditionsOptions {
  readonly tenantId: string;
  readonly sessionId: string | null | undefined;
  readonly opts: HandoffFilter;
  readonly key: ContinuityKey | null | undefined;
  readonly now: Date;
}

function handoffConditions({ tenantId, sessionId, opts, key, now }: HandoffConditionsOptions) {
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
    // Restrict to each session's newest revision first: stampHandoffOutcome only stamps the newest
    // row, so an older null-outcome revision must not resurrect. Keyed, the newest is the owner's
    // own, so another owner's newer revision cannot hide it.
    conditions.push(
      `id IN (SELECT MAX(id) FROM session_handoffs WHERE tenant_id = ?${owned ? ` AND ${owned.sql}` : ''} GROUP BY ` +
        `session_id)`,
    );
    params.push(tenantId, ...(owned?.params ?? []));
    conditions.push(`(outcome IS NULL OR outcome IN ('partial','failure'))`);
  }
  if (opts.maxAgeMs != null) {
    conditions.push('created_at >= ?');
    params.push(new Date(now.getTime() - opts.maxAgeMs).toISOString());
  }
  if (opts.scopeFilter === 'default-deny') {
    // Admit scope before LIMIT 1, else a newer denied row hides an older eligible one.
    const deny = scopeAdmitSql('');
    conditions.push(deny.sql);
    params.push(...deny.params);
  }
  return { conditions, params };
}

export interface ReadLatestHandoffOptions {
  readonly tenantId: string;
  readonly sessionId?: string | null;
  readonly opts?: HandoffFilter;
  readonly key?: ContinuityKey | null;
}

/** Load the most recent handoff, optionally filtered by session ID. */
export function readLatestHandoff(
  db: DatabaseSyncLike,
  { tenantId, sessionId, opts = {}, key }: ReadLatestHandoffOptions,
): SessionHandoff | null {
  assertTenantId('readLatestHandoff', tenantId);
  const { conditions, params } = handoffConditions({
    tenantId,
    sessionId,
    opts,
    key,
    now: handleNow(db),
  });
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
export function readHandoff(
  db: DatabaseSyncLike,
  tenantId: string,
  id: number,
): SessionHandoff | null {
  assertTenantId('readHandoff', tenantId);
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

/** Stamp the outcome on a session's newest handoff, only if it has none yet. Returns rows
 * changed. */
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
  return changedRows(result);
}

/** Rewrites the session's newest handoff when it is still a transcript read, in one statement so
 * a handoff written meanwhile is never overwritten; null when none was rewritten. */
function replaceTranscriptHandoff(
  db: DatabaseSyncLike,
  tenantId: string,
  handoff: Omit<SessionHandoff, 'updatedAt'>,
  key: ContinuityKey | null | undefined,
): SessionHandoff | null {
  const { conditions, params } = handoffConditions({
    tenantId,
    sessionId: handoff.sessionId,
    opts: {},
    key,
    now: handleNow(db),
  });
  const newest = `SELECT id FROM session_handoffs WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, id DESC LIMIT 1`;
  const columns: HandoffColumn[] = [
    ['created_at', handleStamp(db)],
    ...handoffContentColumns(handoff),
  ];
  const assignments = columns.map(([column]) => `${column} = ?`).join(', ');
  const result = cachedStatement(
    db,
    `UPDATE session_handoffs SET ${assignments}
    WHERE id = (${newest}) AND json_valid(evidence_json)
      AND json_extract(evidence_json, '$.derivedFrom') = 'transcript'`,
  ).run(...columns.map(([, value]) => value), ...params);
  if (changedRows(result) === 0) return null;
  const row = cachedStatement(
    db,
    `SELECT ${HANDOFF_COLUMNS} FROM session_handoffs WHERE id = (${newest})`,
  ).get(...params) as SessionHandoffDbRow | undefined;
  return row ? rowToSessionHandoff(row) : null;
}

export interface WriteSessionEndHandoffOptions {
  readonly files: StoreFiles;
  readonly tenantId: string;
  readonly request: SessionEndHandoffRequest;
  readonly key: ContinuityKey | null | undefined;
}

/** Session-end handoff from the active snapshot, else `derived` transcript state; `inPlace`
 * rewrites an earlier transcript read instead of adding a revision. Returns null when no source
 * is the session's, a newer handoff covers it, or the latest one is not transcript-derived or
 * already holds `derived`. */
export function writeSessionEndHandoff(
  db: DatabaseSyncLike,
  { files, tenantId, request, key }: WriteSessionEndHandoffOptions,
): SessionHandoff | null {
  const { sessionId, inPlace } = request;
  assertTenantId('writeSessionEndHandoff', tenantId);
  if (key) continuityStamp(key); // a partial key is a caller bug, so fail loud rather than write nothing
  const active = readActiveTaskSnapshot(db, files, tenantId, key);
  const existing = readLatestHandoff(db, { tenantId, sessionId, opts: {}, key });
  const source = sessionEndSource(active, existing, request);
  if (!source) return null;
  const handoff = sessionEndHandoff(
    sessionId,
    source,
    existing,
    sessionOutcome(db, tenantId, sessionId),
  );
  // A miss means a handoff landed since the read, and a new transcript row would hide it.
  if (source.fromTranscript && inPlace && existing) {
    return replaceTranscriptHandoff(db, tenantId, handoff, key);
  }
  return saveSessionHandoff(db, tenantId, handoff, key);
}

function sessionOutcome(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
): HandoffOutcome | null {
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
