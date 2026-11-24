import {
  HOOK_DB_WAIT_MS,
  sessionOf,
  withWriteScope,
  type DatabaseSyncLike,
  isSqliteBusy,
  noteStoreBusy,
  type RequestStores,
} from '../../../db/index.js';
import { errorMessage, expectedErrorText, log, errorFields } from '../../../base/util/log.js';
import { firstPilotArmHash } from './token-ledger-rows.js';
import { recordTokenUse, lastSentState, recordRereads } from './token-ledger.js';
import { hashArm, type PilotArm } from '../../../base/session/pilot-arm.js';
import {
  type DeliveryPruneSchedule,
  writeDeliveryEventOnHandle,
  deliveryPruneSchedule,
  writeDeliveryEventVia,
} from './delivery-ledger.js';
import type { Ledger, LedgerTurn, PilotArmOptions } from '../../../base/ports/store/ledger.js';
import type { DeliveryEventInput } from '../../../base/session/delivery.js';
import type { OnHandle } from '../runtime/open.js';
import { answered, bound } from '../runtime/bound.js';
import { ALL_TENANTS, type TenantId } from '../../../base/util/tenant.js';

function readPilotArm(
  db: DatabaseSyncLike,
  sessionId: string,
  tenantId: TenantId,
): PilotArm | null {
  const row = firstPilotArmHash(db, sessionId, tenantId);
  return row?.block_hash === 'holdout' || row?.block_hash === 'hippo' ? row.block_hash : null;
}

interface EnsurePilotArmOptions {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly rateBp: number;
  readonly opts?: { ownTenantOnly?: boolean; now?: string };
}

function ensurePilotArm(
  db: DatabaseSyncLike,
  { tenantId, sessionId, rateBp, opts = {} }: EnsurePilotArmOptions,
): PilotArm {
  const hashed = hashArm(sessionId, rateBp);
  const readTenant = opts.ownTenantOnly ? tenantId : ALL_TENANTS;
  try {
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
      { busyWaitMs: sessionOf(db)?.busyWaitMs ?? HOOK_DB_WAIT_MS },
    );
  } catch (err) {
    log.debug(`pilot arm not stored, using the hash arm: ${errorMessage(err)}`, errorFields(err));
    return hashed;
  }
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

type LedgerSkip = 'busy' | 'absent' | 'unexpected';

function ledgerSkipClass<E>(error: E): LedgerSkip {
  if (isSqliteBusy(error)) return 'busy';
  const code = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return 'absent';
  return errorMessage(error).includes('no such table: token_ledger') ? 'absent' : 'unexpected';
}

function noteLedgerRowSkipped<E>(error: E, session: RequestStores | undefined): void {
  const skip = ledgerSkipClass(error);
  if (skip === 'busy') {
    noteStoreBusy('token ledger row skipped', session);
    return;
  }
  if (skip === 'absent') {
    log.debug(`token ledger row skipped: ${expectedErrorText(error)}`);
    return;
  }
  log.warnThenDebug(
    'token-ledger-row',
    `token ledger row skipped: ${errorMessage(error)}`,
    errorFields(error),
  );
}

function recordRows(
  db: DatabaseSyncLike,
  turn: LedgerTurn,
  session: RequestStores | undefined,
): void {
  try {
    for (const use of turn.uses) {
      if (turn.perRow !== true) {
        recordTokenUse(db, use);
        continue;
      }
      try {
        recordTokenUse(db, use);
      } catch (error) {
        noteLedgerRowSkipped(error, session);
      }
    }
  } catch (error) {
    noteLedgerRowSkipped(error, session);
  }
}

function recordDelivery(
  db: DatabaseSyncLike,
  input: DeliveryEventInput,
  prune: DeliveryPruneSchedule,
): void {
  try {
    writeDeliveryEventOnHandle(db, input, prune);
  } catch (error) {
    log.error(`delivery ledger write failed: ${errorMessage(error)}`, errorFields(error));
  }
}

interface LedgerWiring {
  readonly on: OnHandle;
  readonly session: RequestStores | undefined;
  readonly prune: DeliveryPruneSchedule;
}

function recordTurnVia({ on, session, prune }: LedgerWiring, turn: LedgerTurn): void {
  const { delivery } = turn;
  let opened = false;
  try {
    on((db) => {
      opened = true;
      recordRows(db, turn, session);
      if (delivery !== undefined) recordDelivery(db, delivery, prune);
    });
  } catch (error) {
    if (turn.uses.length > 0) noteLedgerRowSkipped(error, session);
    if (!opened && delivery !== undefined) writeDeliveryEventVia(on, delivery, prune);
  }
}

function noting<T>(session: RequestStores | undefined, read: () => T, fallback: () => T): T {
  try {
    return read();
  } catch (error) {
    noteLedgerRowSkipped(error, session);
    return fallback();
  }
}

function pilotArm(
  db: DatabaseSyncLike,
  tenantId: string,
  sessionId: string,
  rateBp: number,
  opts: PilotArmOptions,
): PilotArm {
  const { ownTenantOnly } = opts;
  return opts.write
    ? ensurePilotArm(db, { tenantId, sessionId, rateBp, opts: { ownTenantOnly } })
    : (readPilotArm(db, sessionId, ownTenantOnly ? tenantId : ALL_TENANTS) ??
        hashArm(sessionId, rateBp));
}

/** Each call runs on the request's handle or a short-lived one. A turn takes the opener, since
 * its delivery event is tried again on its own when the open fails; a busy skip tells `session`,
 * so a hook's later writes skip at once. */
export function sqliteLedger(on: OnHandle, session?: RequestStores): Ledger {
  const wiring: LedgerWiring = { on, session, prune: deliveryPruneSchedule() };
  return {
    recordTurn: (turn) => answered(() => recordTurnVia(wiring, turn)),
    lastSent: (tenantId, sessionId, surface) =>
      answered(() =>
        noting(
          session,
          () => on((db) => lastSentState(db, tenantId, sessionId, surface)),
          () => null,
        ),
      ),
    pilotArm: (tenantId, sessionId, rateBp, opts) =>
      answered(() =>
        noting(
          session,
          () => on((db) => pilotArm(db, tenantId, sessionId, rateBp, opts)),
          () => hashArm(sessionId, rateBp),
        ),
      ),
    ...bound<Pick<Ledger, 'replaceRereads'>>(on, { replaceRereads: recordRereads }),
  };
}
