// The in-memory session handoffs: kept as SessionHandoffRow, so each reads back through the shared row codec.
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import {
  isHandoffOutcome,
  rowToSessionHandoff,
  type HandoffOutcome,
  type SessionHandoff,
  type SessionHandoffRow,
} from '../../base/session/handoff.js';
import type { HandoffFilter, SessionEndHandoffRequest } from '../port/sessions.js';
import { isJsonObject, tryParseJson } from '../../base/util/json.js';
import type { ContinuityKey } from '../port/types.js';
import { byBytes, newestFirst } from '../rules/order.js';
import { sessionEndHandoff, sessionEndSource } from '../rules/session-end.js';
import { nextId } from './rows.js';
import type { Owned } from './session-tables.js';
import { keyMatches, loadSnapshotIn, sessionCompletion, stampOf } from './snapshots.js';
import type { MemoryTables } from './tables.js';

type Handoff = Omit<SessionHandoff, 'updatedAt'>;
type Stored = Owned<SessionHandoffRow>;

/** The columns every write of `handoff` sets, on an insert and an in-place rewrite alike. */
function columnsOf(handoff: Handoff, now: string): Omit<SessionHandoffRow, 'id' | 'session_id'> {
  return {
    repo_root: handoff.repoRoot ?? null,
    task_id: handoff.taskId ?? null,
    summary: handoff.summary,
    next_action: handoff.nextAction ?? null,
    artifacts_json: JSON.stringify(handoff.artifacts ?? []),
    scope: handoff.scope ?? null,
    created_at: now,
    constraints_json: JSON.stringify(handoff.constraints ?? []),
    evidence_json: handoff.evidence ? JSON.stringify(handoff.evidence) : null,
    outcome: handoff.outcome ?? null,
    target_runtime: handoff.targetRuntime ?? null,
    card_id: handoff.cardId ?? null,
  };
}

export function saveHandoffIn(t: MemoryTables, tenantId: string, handoff: Handoff, key: ContinuityKey | null) {
  const stamp = stampOf(key);
  const id = nextId(t, 'session_handoffs');
  const row: SessionHandoffRow = { id, session_id: handoff.sessionId, ...columnsOf(handoff, new Date().toISOString()) };
  t.handoffs.push({ tenantId, row, ...stamp });
  return rowToSessionHandoff(row);
}

const newestHandoff = newestFirst<Stored>({ key: (h) => h.row.created_at, intId: (h) => h.row.id });

/** Each session's newest revision among the key's rows, since an outcome is only ever stamped on that one. */
function newestRevisions(t: MemoryTables, tenantId: string, key: ContinuityKey | null): Set<number> {
  const newest = new Map<string, number>();
  for (const h of t.handoffs) {
    if (h.tenantId !== tenantId || !keyMatches(key, h)) continue;
    newest.set(h.row.session_id, Math.max(newest.get(h.row.session_id) ?? 0, h.row.id));
  }
  return new Set(newest.values());
}

/** The handoff filter; the scope test runs before the newest is picked, so a denied row never hides another. */
function handoffMatcher(
  t: MemoryTables,
  tenantId: string,
  sessionId: string | null,
  filter: HandoffFilter,
  key: ContinuityKey | null,
): (h: Stored) => boolean {
  const revisions = filter.unfinishedOnly ? newestRevisions(t, tenantId, key) : null;
  const since = filter.maxAgeMs != null ? new Date(Date.now() - filter.maxAgeMs).toISOString() : null;
  const unfinished = (outcome: string | null): boolean =>
    outcome === null || outcome === 'partial' || outcome === 'failure';
  return ({ row, ...h }) =>
    h.tenantId === tenantId &&
    keyMatches(key, { row, ...h }) &&
    (!sessionId || row.session_id === sessionId) &&
    (!filter.excludeSessionId || row.session_id !== filter.excludeSessionId) &&
    (revisions === null || (revisions.has(row.id) && unfinished(row.outcome))) &&
    (since === null || byBytes(row.created_at, since) >= 0) &&
    (filter.scopeFilter !== 'default-deny' || passesScopeFilterForRecall(row.scope, undefined));
}

function newestMatching(
  t: MemoryTables,
  tenantId: string,
  sessionId: string | null,
  filter: HandoffFilter,
  key: ContinuityKey | null,
) {
  return t.handoffs.filter(handoffMatcher(t, tenantId, sessionId, filter, key)).sort(newestHandoff)[0];
}

export function latestHandoffIn(
  t: MemoryTables,
  tenantId: string,
  sessionId: string | null,
  filter: HandoffFilter,
  key: ContinuityKey | null,
): SessionHandoff | null {
  const newest = newestMatching(t, tenantId, sessionId, filter, key);
  return newest ? rowToSessionHandoff(newest.row) : null;
}

/** Stamps the session's newest handoff only while it has no outcome. */
export function stampOutcomeIn(t: MemoryTables, tenantId: string, sessionId: string, outcome: HandoffOutcome): number {
  const newest = t.handoffs
    .filter((h) => h.tenantId === tenantId && h.row.session_id === sessionId)
    .sort(newestHandoff)[0];
  if (!newest || newest.row.outcome !== null) return 0;
  newest.row = { ...newest.row, outcome };
  return 1;
}

/** Only valid evidence JSON naming the transcript counts as a transcript read. */
function readFromTranscript(evidence: string | null): boolean {
  if (evidence === null) return false;
  const parsed = tryParseJson(evidence);
  return isJsonObject(parsed) && parsed.derivedFrom === 'transcript';
}

/** Rewrites the session's newest handoff while it is still a transcript read; null when none was rewritten. */
function replaceTranscriptIn(t: MemoryTables, tenantId: string, handoff: Handoff, key: ContinuityKey | null) {
  const newest = newestMatching(t, tenantId, handoff.sessionId, {}, key);
  if (!newest || !readFromTranscript(newest.row.evidence_json)) return null;
  newest.row = { ...newest.row, ...columnsOf(handoff, new Date().toISOString()) };
  return rowToSessionHandoff(newest.row);
}

export function writeSessionEndIn(
  t: MemoryTables,
  tenantId: string,
  request: Omit<SessionEndHandoffRequest, 'tenantId'>,
) {
  const { sessionId, key = null, inPlace } = request;
  if (key) stampOf(key);
  const existing = latestHandoffIn(t, tenantId, sessionId, {}, key);
  const source = sessionEndSource(loadSnapshotIn(t, tenantId, key), existing, request);
  if (!source) return null;
  const done = sessionCompletion(t, tenantId, sessionId);
  const handoff = sessionEndHandoff(sessionId, source, existing, isHandoffOutcome(done) ? done : null);
  // A miss means a handoff landed since the read, and a new transcript row would hide it.
  if (source.fromTranscript && inPlace && existing) return replaceTranscriptIn(t, tenantId, handoff, key);
  return saveHandoffIn(t, tenantId, handoff, key);
}

export function handoffByIdIn(t: MemoryTables, tenantId: string, id: number): SessionHandoff | null {
  const found = t.handoffs.find((h) => h.tenantId === tenantId && h.row.id === id);
  return found ? rowToSessionHandoff(found.row) : null;
}
