// Which pilot arm a session is in: the rate comes from the ledger store's config, the arm row from its Ledger.
import { ledgerFiles, onLedger, type LedgerReach } from './ledger-db.js';
import { hashArm, type PilotArm } from '../store/pilot-arm.js';

export interface SessionArmOptions {
  readonly reach: LedgerReach;
  /**
   * Only the caller tenant's arm row counts, so a caller holding another tenant's session id cannot claim that
   * session's arm.
   */
  readonly ownTenantOnly?: boolean;
}

/** The session's arm, or null at rate 0, with no session id, or with no store.
 *  `write` books the arm row; a read-only caller (env-only id, sub-agent) follows the stored arm, else the hash. */
export function sessionPilotArm(
  tenantId: string,
  sessionId: string | undefined,
  write: boolean,
  opts: SessionArmOptions,
): PilotArm | null {
  if (sessionId === undefined || sessionId.trim() === '') return null;
  const home = ledgerFiles(opts.reach);
  if (home === null) return null;
  const rate = home.config.pilot.holdoutRateBp;
  if (rate <= 0) return null;
  const { ownTenantOnly } = opts;
  const arm = onLedger(opts.reach, (ledger) => ledger.pilotArm(tenantId, sessionId, rate, { write, ownTenantOnly }));
  return arm ?? hashArm(sessionId, rate);
}
