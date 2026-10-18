import { HOUR_MS } from '../util/time.js';

/** Default freshness bound for AMBIENT active-task-snapshot reads: 72h rather than 48h so a Friday-evening orphan still
 * offers continuity on Monday; override via `loadFreshActiveTaskSnapshot`'s `opts.maxAgeMs`; deliberately no env
 * knob. */
export const SNAPSHOT_AMBIENT_MAX_AGE_MS = 72 * HOUR_MS;

/** A usable session id: non-null, non-empty string; named so the owner-match rule in `loadFreshActiveTaskSnapshot`
 * states its contract once. */
function isNonEmptySessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `loadFreshActiveTaskSnapshot`'s owner-match-or-age rule, for a snapshot a store read. */
export function freshActiveSnapshot<S extends { session_id: string | null; updated_at: string }>(
  snapshot: S | null,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
): S | null {
  if (!snapshot) return null;

  const callerSessionId = opts.sessionId;
  const isOwnerMatch =
    isNonEmptySessionId(callerSessionId) &&
    isNonEmptySessionId(snapshot.session_id) &&
    callerSessionId === snapshot.session_id;
  if (isOwnerMatch) return snapshot;

  const maxAgeMs = opts.maxAgeMs ?? SNAPSHOT_AMBIENT_MAX_AGE_MS;
  const ageMs = Date.now() - Date.parse(snapshot.updated_at);
  return ageMs <= maxAgeMs ? snapshot : null;
}
