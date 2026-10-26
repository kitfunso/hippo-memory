import { HOUR_MS } from '../util/time.js';

/** Default freshness bound for AMBIENT active-task-snapshot reads: 72h rather than 48h so a
 * Friday-evening orphan still offers continuity on Monday; override via an ambient load's
 * `maxAgeMs`; deliberately no env knob.
 */
export const SNAPSHOT_AMBIENT_MAX_AGE_MS = 72 * HOUR_MS;

/** A usable session id: non-null, non-empty string; named so the owner-match rule in
 * `freshActiveSnapshot` states its contract once. */
function isNonEmptySessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The ambient read's rule, so orphaned snapshots expire: the owner (both session ids non-empty
 * and `===`) always sees its own state; all others, null ids included, get it only if
 * age(updated_at) <= maxAgeMs, else null. */
export function freshActiveSnapshot<S extends { sessionId: string | null; updatedAt: string }>(
  snapshot: S | null,
  opts: { maxAgeMs?: number; sessionId?: string | null } = {},
): S | null {
  if (!snapshot) return null;

  const callerSessionId = opts.sessionId;
  const isOwnerMatch =
    isNonEmptySessionId(callerSessionId) &&
    isNonEmptySessionId(snapshot.sessionId) &&
    callerSessionId === snapshot.sessionId;
  if (isOwnerMatch) return snapshot;

  const maxAgeMs = opts.maxAgeMs ?? SNAPSHOT_AMBIENT_MAX_AGE_MS;
  const ageMs = Date.now() - Date.parse(snapshot.updatedAt);
  return ageMs <= maxAgeMs ? snapshot : null;
}
