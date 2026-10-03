// Pilot arm (ROADMAP CD11): one token_ledger row per session names its arm, `hippo` or `holdout`.
// `items` holds the holdout rate in basis points. Contract: docs/decisions/2026-10-03-pilot-arm.md.
import { createHash } from 'node:crypto';
import { execWithBusyRetry, type DatabaseSyncLike } from './db.js';
import { recordTokenUse } from './token-ledger.js';

export type PilotArm = 'hippo' | 'holdout';

// The hook runs on every prompt, so a locked store may cost it about a second, not the default five.
export const ARM_LOCK_WAIT_MS = 1000;

/** Deterministic split: the same session and rate always land in the same arm. */
export function hashArm(sessionId: string, rateBp: number): PilotArm {
  const bucket = parseInt(createHash('sha256').update(sessionId).digest('hex').slice(0, 8), 16) % 10000;
  return bucket < rateBp ? 'holdout' : 'hippo';
}

/** The session's first stored arm, or null; never writes. No tenant filter: a session has one arm. */
export function readPilotArm(db: DatabaseSyncLike, sessionId: string): PilotArm | null {
  // SAFETY: the SELECT names exactly this one column.
  const row = db.prepare(
    `SELECT block_hash FROM token_ledger WHERE session_id = ? AND surface = 'pilot' AND event = 'arm' ORDER BY id LIMIT 1`,
  ).get(sessionId) as { block_hash: string | null } | undefined;
  return row?.block_hash === 'holdout' || row?.block_hash === 'hippo' ? row.block_hash : null;
}

/** The stored arm, else the hash arm written once; on any error the hash arm comes back unrecorded. */
// The 1 s bound holds only on a handle opened with `busyWaitMs: ARM_LOCK_WAIT_MS`.
export function ensurePilotArm(
  db: DatabaseSyncLike, tenantId: string, sessionId: string, rateBp: number, now?: string,
): PilotArm {
  const hashed = hashArm(sessionId, rateBp);
  let began = false;
  try {
    // A stored row is the common case after the first prompt, so it must not take the write lock.
    const existing = readPilotArm(db, sessionId);
    if (existing !== null) return existing;
    execWithBusyRetry(db, 'BEGIN IMMEDIATE', ARM_LOCK_WAIT_MS);
    began = true;
    const stored = readPilotArm(db, sessionId);
    if (stored === null) {
      recordTokenUse(db, { tenantId, sessionId, surface: 'pilot', event: 'arm', items: rateBp, tokens: 0, hash: hashed, now });
    }
    db.exec('COMMIT');
    return stored ?? hashed;
  } catch {
    // A prompt hook must not fail on pilot bookkeeping; concurrent callers still agree on the hash arm.
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* keep the hash arm */ }
    }
    return hashed;
  }
}
