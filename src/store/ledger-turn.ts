// One hook or context turn's token-ledger work on one hippo.db handle, and the rule for a row that did not land.
import { isSqliteBusy, noteStoreBusy, type DatabaseSyncLike } from '../db/index.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import type { DeliveryEventInput } from './delivery-recorder.js';
import { recordTokenUse, type TokenUse } from './token-ledger.js';
import { ensurePilotArm, hashArm, readPilotArm, type PilotArm } from './pilot-arm.js';
import { writeDeliveryEventOnHandle } from './recall-trace.js';

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
export function noteLedgerRowSkipped<E>(error: E): void {
  const skip = ledgerSkipClass(error);
  if (skip === 'busy') {
    noteStoreBusy('token ledger row skipped');
    return;
  }
  const message = `token ledger row skipped: ${errorMessage(error)}`;
  if (skip === 'absent') log.debug(message);
  else log.warnThenDebug('token-ledger-row', message, errorFields(error));
}

/** Stores one delivery event and returns its id, or null when the write failed. */
export type DeliveryWrite = (input: DeliveryEventInput) => number | null;

/** The token rows of one turn and the delivery event that follows them. */
export interface LedgerTurn {
  readonly uses: readonly TokenUse[];
  /** Makes each row its own attempt: a failed one is reported here and the rest still run. Without it the first failure
   * throws. */
  readonly onRowError?: <E>(error: E) => void;
  /** Runs after the rows with a writer on their connection, so the delivery event costs no second open. */
  readonly delivery?: (write: DeliveryWrite) => void;
}

/** Books a turn's token rows, then its delivery event, on `db`. */
export function recordLedgerTurnAt(db: DatabaseSyncLike, turn: LedgerTurn): void {
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
  turn.delivery?.((input) => writeDeliveryEventOnHandle(db, input));
}

/** The session's pilot arm: `write` books it as ensurePilotArm does, else the stored arm or the hash arm. */
export function pilotArmAt(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  rateBp: number,
  opts: { write: boolean; ownTenantOnly?: boolean },
): PilotArm {
  const { ownTenantOnly } = opts;
  return opts.write
    ? ensurePilotArm(db, tenantId, sessionId, rateBp, { ownTenantOnly })
    : (readPilotArm(db, sessionId, ownTenantOnly ? tenantId : undefined) ?? hashArm(sessionId, rateBp));
}
