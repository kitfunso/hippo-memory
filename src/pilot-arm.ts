// Pilot arm: one token_ledger row per session names its arm, `hippo` or `holdout`, so a pilot can compare them.
// `items` holds the holdout rate in basis points; readers outside this repo depend on these rows, so their shape is fixed.
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { execWithBusyRetry, HOOK_DB_WAIT_MS, scopedBusyWait, type DatabaseSyncLike } from './db.js';
import { ledgerRoot, withLedgerDb, type LedgerRootOpts } from './ledger-db.js';
import { errorMessage, log } from './log.js';
import { recordTokenUse } from './token-ledger.js';

export type PilotArm = 'hippo' | 'holdout';

export interface SessionArmOpts extends LedgerRootOpts {
  /** Only the caller tenant's arm row counts, so a caller holding another tenant's session id cannot claim that session's arm. */
  readonly ownTenantOnly?: boolean;
}

/** Deterministic split: the same session and rate always land in the same arm. */
export function hashArm(sessionId: string, rateBp: number): PilotArm {
  const bucket = parseInt(createHash('sha256').update(sessionId).digest('hex').slice(0, 8), 16) % 10000;
  return bucket < rateBp ? 'holdout' : 'hippo';
}

/** The session's first stored arm, or null; never writes. Without `tenantId` any tenant's row counts, since on one machine a session has one arm. */
export function readPilotArm(db: DatabaseSyncLike, sessionId: string, tenantId?: string): PilotArm | null {
  const params = tenantId === undefined ? [sessionId] : [sessionId, tenantId];
  // SAFETY: the SELECT names exactly this one column.
  const row = db.prepare(
    `SELECT block_hash FROM token_ledger WHERE session_id = ?${tenantId === undefined ? '' : ' AND tenant_id = ?'}
     AND surface = 'pilot' AND event = 'arm' ORDER BY id LIMIT 1`,
  ).get(...params) as { block_hash: string | null } | undefined;
  return row?.block_hash === 'holdout' || row?.block_hash === 'hippo' ? row.block_hash : null;
}

/** The stored arm, else the hash arm written once; on any error the hash arm comes back unrecorded. */
// The wait is the caller's lock-wait scope (a hook's 1 s, a server request's 250 ms); it holds on a handle opened in that scope.
export function ensurePilotArm(
  db: DatabaseSyncLike, tenantId: string, sessionId: string, rateBp: number, opts: { ownTenantOnly?: boolean; now?: string } = {},
): PilotArm {
  const hashed = hashArm(sessionId, rateBp);
  const readTenant = opts.ownTenantOnly ? tenantId : undefined;
  let began = false;
  try {
    // A stored row is the common case after the first prompt, so it must not take the write lock.
    const existing = readPilotArm(db, sessionId, readTenant);
    if (existing !== null) return existing;
    execWithBusyRetry(db, 'BEGIN IMMEDIATE', scopedBusyWait() ?? HOOK_DB_WAIT_MS);
    began = true;
    const stored = readPilotArm(db, sessionId, readTenant);
    if (stored === null) {
      recordTokenUse(db, { tenantId, sessionId, surface: 'pilot', event: 'arm', items: rateBp, tokens: 0, hash: hashed, now: opts.now });
    }
    db.exec('COMMIT');
    return stored ?? hashed;
  } catch (err) {
    // A prompt hook must not fail on pilot bookkeeping; concurrent callers still agree on the hash arm.
    log.debug(`pilot arm not stored, using the hash arm: ${errorMessage(err)}`);
    if (began) {
      try { db.exec('ROLLBACK'); } catch { /* keep the hash arm */ }
    }
    return hashed;
  }
}

/** The session's arm, or null at rate 0, with no session id, or with no store.
 *  `write` books the arm row; a read-only caller (env-only id, sub-agent) follows the stored arm, else the hash. */
export function sessionPilotArm(
  hippoRoot: string, tenantId: string, sessionId: string | undefined, write: boolean, opts: SessionArmOpts = {},
): PilotArm | null {
  if (sessionId === undefined || sessionId.trim() === '') return null;
  const root = ledgerRoot(hippoRoot, opts);
  if (root === null) return null;
  const rate = loadConfig(root).pilot.holdoutRateBp;
  if (rate <= 0) return null;
  const { ownTenantOnly } = opts;
  const arm = withLedgerDb(hippoRoot, (db) => write
    ? ensurePilotArm(db, tenantId, sessionId, rate, { ownTenantOnly })
    : readPilotArm(db, sessionId, ownTenantOnly ? tenantId : undefined) ?? hashArm(sessionId, rate), opts);
  return arm ?? hashArm(sessionId, rate);
}
