// hippo.db's Ledger group: a turn's token-ledger rows, the pilot arm and delivery events.
import {
  HOOK_DB_WAIT_MS,
  scopedBusyWait,
  withWriteScope,
  type DatabaseSyncLike,
  isSqliteBusy,
  noteStoreBusy,
} from '../../db/index.js';
import { errorMessage, log, errorFields } from '../../util/log.js';
import { firstPilotArmHash } from './token-ledger-rows.js';
import { recordTokenUse, lastSentState, recordRereadsAt } from './token-ledger.js';
import { hashArm, type PilotArm } from '../../core/pilot-arm.js';
import {
  type DeliveryPruneSchedule,
  writeDeliveryEventOnHandle,
  deliveryPruneSchedule,
  writeDeliveryEventVia,
} from './recall-trace.js';
import type { LedgerTurn, Ledger } from '../port/ledger.js';
import type { OnHandle } from './open.js';
import { ALL_TENANTS, type TenantId } from '../../util/tenant.js';

// One token_ledger row per session names its pilot arm, `hippo` or `holdout`, with the holdout rate in basis points in
// `items`; readers outside this repo depend on these rows, so their shape is fixed.
/** The session's first stored arm, or null; never writes. */
function readPilotArm(db: DatabaseSyncLike, sessionId: string, tenantId: TenantId): PilotArm | null {
  const row = firstPilotArmHash(db, sessionId, tenantId);
  return row?.block_hash === 'holdout' || row?.block_hash === 'hippo' ? row.block_hash : null;
}

/** The stored arm, else the hash arm written once; on any error the hash arm comes back unrecorded. */
// The wait is the caller's lock-wait scope (a hook's 1 s, a server request's 250 ms); it holds on a handle opened in
// that scope.
function ensurePilotArm(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  rateBp: number,
  opts: { ownTenantOnly?: boolean; now?: string } = {},
): PilotArm {
  const hashed = hashArm(sessionId, rateBp);
  // On one machine a session has one arm, so any tenant's row counts unless the caller holds only its own.
  const readTenant = opts.ownTenantOnly ? tenantId : ALL_TENANTS;
  try {
    // A stored row is the common case after the first prompt, so it must not take the write lock.
    const existing = readPilotArm(db, sessionId, readTenant);
    if (existing !== null) return existing;
    return withWriteScope(
      db,
      'pilot_arm',
      () => {
        const stored = readPilotArm(db, sessionId, readTenant);
        if (stored === null) {
          recordTokenUse(db, {
            tenantId,
            sessionId,
            surface: 'pilot',
            event: 'arm',
            items: rateBp,
            tokens: 0,
            hash: hashed,
            now: opts.now,
          });
        }
        return stored ?? hashed;
      },
      { busyWaitMs: scopedBusyWait() ?? HOOK_DB_WAIT_MS },
    );
  } catch (err) {
    // A prompt hook must not fail on pilot bookkeeping; concurrent callers still agree on the hash arm.
    log.debug(`pilot arm not stored, using the hash arm: ${errorMessage(err)}`, errorFields(err));
    return hashed;
  }
}

// SQLite's result codes for a hippo.db it cannot read: a corrupt image, and a file that is no database.
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

/** Why a ledger row did not land: the store is `busy`, it has no ledger to write to
 * (`absent`), or the write failed for a reason nobody planned for (`unexpected`). */
type LedgerSkip = 'busy' | 'absent' | 'unexpected';

/** The one rule for a skipped ledger row. `absent` is a store with no token_ledger table or a hippo.db
 * SQLite cannot read; the command that owns the store reports that, and a hook must stay quiet about it. */
function ledgerSkipClass<E>(error: E): LedgerSkip {
  if (isSqliteBusy(error)) return 'busy';
  const code = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return 'absent';
  return errorMessage(error).includes('no such table: token_ledger') ? 'absent' : 'unexpected';
}

/** Says why a ledger row did not land, at the level its class earns: busy warns once through
 * noteStoreBusy, absent is debug with no stack, unexpected warns once with the error class and stack. */
function noteLedgerRowSkipped<E>(error: E): void {
  const skip = ledgerSkipClass(error);
  if (skip === 'busy') {
    noteStoreBusy('token ledger row skipped');
    return;
  }
  const message = `token ledger row skipped: ${errorMessage(error)}`;
  if (skip === 'absent') log.debug(message);
  else log.warnThenDebug('token-ledger-row', message, errorFields(error));
}

/** Books a turn's token rows, then its delivery event, on `db`. */
function recordLedgerTurnAt(db: DatabaseSyncLike, turn: LedgerTurn, prune: DeliveryPruneSchedule): void {
  const { onRowError } = turn;
  for (const use of turn.uses) {
    if (onRowError === undefined) {
      recordTokenUse(db, use);
      continue;
    }
    try {
      recordTokenUse(db, use);
    } catch (error) {
      onRowError(error);
    }
  }
  turn.delivery?.((input) => writeDeliveryEventOnHandle(db, input, prune));
}

/** The session's pilot arm: `write` books it as ensurePilotArm does, else the stored arm or the hash arm. */
function pilotArmAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  rateBp: number,
  opts: { write: boolean; ownTenantOnly?: boolean },
): PilotArm {
  const { ownTenantOnly } = opts;
  return opts.write
    ? ensurePilotArm(db, tenantId, sessionId, rateBp, { ownTenantOnly })
    : (readPilotArm(db, sessionId, ownTenantOnly ? tenantId : ALL_TENANTS) ?? hashArm(sessionId, rateBp));
}

/** Each call runs on the request's handle or a short-lived one. The delivery write takes the opener, since it is
 * fail-soft on an open that fails. */
export function sqliteLedger(on: OnHandle): Ledger {
  // One schedule per store, so a long-lived server prunes the delivery ledger once a minute, not on every event.
  const prune = deliveryPruneSchedule();
  return {
    recordTurn: (turn) => on((db) => recordLedgerTurnAt(db, turn, prune)),
    recordTokens: (use) => on((db) => recordTokenUse(db, use)),
    lastSent: (tenantId, sessionId, surface) => on((db) => lastSentState(db, tenantId, sessionId, surface)),
    pilotArm: (tenantId, sessionId, rateBp, opts) => on((db) => pilotArmAt(db, tenantId, sessionId, rateBp, opts)),
    writeDeliveryEvent: (input) => writeDeliveryEventVia(on, input, prune),
    noteSkipped: noteLedgerRowSkipped,
    replaceRereads: (tenantId, sessionId, calls) => on((db) => recordRereadsAt(db, tenantId, sessionId, calls)),
  };
}
