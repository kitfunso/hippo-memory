// The in-memory session handoffs: kept as hippo.db's rows, so each reads back through the same row codec.
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import {
  isHandoffOutcome,
  rowToSessionHandoff,
  type HandoffEvidence,
  type HandoffOutcome,
  type SessionHandoff,
  type SessionHandoffRow,
} from '../../base/session/handoff.js';
import type { HandoffFilter, SessionEndHandoffRequest, TaskSnapshot } from '../port/sessions.js';
import { isJsonObject, tryParseJson } from '../../base/util/json.js';
import type { ContinuityKey } from '../port/types.js';
import { byBytes, newestFirst } from '../rules/order.js';
import { nextId } from './rows.js';
import type { Owned } from './session-tables.js';
import { keyMatches, loadSnapshotIn, sessionCompletion, stampOf } from './snapshots.js';
import type { MemoryTables } from './tables.js';

type Handoff = Omit<SessionHandoff, 'updatedAt'>;
type Stored = Owned<SessionHandoffRow>;
type HandoffSnapshot = Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep' | 'scope'>;

/** The columns every write of `handoff` sets, as hippo.db's insert and in-place rewrite bind them. */
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

/** hippo.db's handoff filter; the scope test runs before the newest is picked, so a denied row never hides another. */
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

/** As hippo.db's json_extract: only valid evidence JSON naming the transcript counts. */
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

// Copied from hippo.db's adapter, where it is not exported: only an earlier transcript read gives way, and a retried
// session end that reads the same transcript adds no second revision.
function transcriptSource(
  existing: SessionHandoff | null,
  derived: Pick<TaskSnapshot, 'task' | 'summary' | 'nextStep'> | null,
  evidence: HandoffEvidence | null,
): { snapshot: HandoffSnapshot; evidence: HandoffEvidence } | null {
  if (!derived || (existing && existing.evidence?.derivedFrom !== 'transcript')) return null;
  const same =
    existing?.taskId === derived.task &&
    existing.summary === derived.summary &&
    existing.nextAction === derived.nextStep;
  if (existing && same) return null;
  return { snapshot: { ...derived, scope: null }, evidence: { ...evidence, derivedFrom: 'transcript' } };
}

// A same-task refresh carries forward the envelope fields nobody cleared; a scope mismatch carries none.
function sessionEndHandoff(
  sessionId: string,
  snapshot: HandoffSnapshot,
  existing: SessionHandoff | null,
  evidence: HandoffEvidence | null,
  outcome: HandoffOutcome | null,
): Handoff {
  const carry =
    existing != null && existing.taskId === snapshot.task && (existing.scope ?? null) === (snapshot.scope ?? null);
  return {
    version: 1,
    sessionId,
    repoRoot: carry ? existing.repoRoot : undefined,
    taskId: snapshot.task,
    summary: snapshot.summary,
    nextAction: snapshot.nextStep,
    artifacts: carry ? existing.artifacts : [],
    scope: snapshot.scope,
    evidence,
    outcome,
    constraints: carry ? existing.constraints : undefined,
    targetRuntime: carry ? existing.targetRuntime : undefined,
    cardId: carry ? existing.cardId : undefined,
  };
}

/** The snapshot and evidence a session end writes from, or null when a newer handoff already covers it. */
function sessionEndSource(
  t: MemoryTables,
  tenantId: string,
  request: Omit<SessionEndHandoffRequest, 'tenantId'>,
  existing: SessionHandoff | null,
) {
  const { sessionId, evidence, derived = null, key, inPlace } = request;
  const active = loadSnapshotIn(t, tenantId, key);
  // After every reply the transcript is newer than the last compaction's snapshot.
  const snapshotGivesWay = inPlace === true && derived !== null && active?.source === 'pre-compact';
  if (active && active.sessionId === sessionId && !snapshotGivesWay) {
    // Strict '>': a same-millisecond tie must not swallow the session's only write.
    if (existing && existing.updatedAt > active.updatedAt) return null;
    return { snapshot: active, evidence, fromTranscript: false };
  }
  const fromDerived = transcriptSource(existing, derived, evidence);
  return fromDerived && { ...fromDerived, fromTranscript: true };
}

export function writeSessionEndIn(
  t: MemoryTables,
  tenantId: string,
  request: Omit<SessionEndHandoffRequest, 'tenantId'>,
) {
  const { sessionId, key = null, inPlace } = request;
  if (key) stampOf(key);
  const existing = latestHandoffIn(t, tenantId, sessionId, {}, key);
  const source = sessionEndSource(t, tenantId, request, existing);
  if (!source) return null;
  const done = sessionCompletion(t, tenantId, sessionId);
  const outcome = isHandoffOutcome(done) ? done : null;
  const handoff = sessionEndHandoff(sessionId, source.snapshot, existing, source.evidence, outcome);
  // A miss means a handoff landed since the read, and a new transcript row would hide it.
  if (source.fromTranscript && inPlace && existing) return replaceTranscriptIn(t, tenantId, handoff, key);
  return saveHandoffIn(t, tenantId, handoff, key);
}

export function handoffByIdIn(t: MemoryTables, tenantId: string, id: number): SessionHandoff | null {
  const found = t.handoffs.find((h) => h.tenantId === tenantId && h.row.id === id);
  return found ? rowToSessionHandoff(found.row) : null;
}
