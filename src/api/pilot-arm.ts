// Which pilot arm a session is in: the rate comes from the ledger store's config, the arm row from src/store/pilot-arm.ts.
import { loadConfig } from '../core/config.js';
import { ledgerRoot, onLedgerRoot, type LedgerRootOpts } from './ledger-db.js';
import { pilotArmOnRoot } from '../store/ledger-turn.js';
import { hashArm, type PilotArm } from '../store/pilot-arm.js';

export interface SessionArmOpts extends LedgerRootOpts {
  /** Only the caller tenant's arm row counts, so a caller holding another tenant's session id cannot claim that session's arm. */
  readonly ownTenantOnly?: boolean;
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
  const arm = onLedgerRoot(hippoRoot, opts, (at) => pilotArmOnRoot(at, tenantId, sessionId, rate, { write, ownTenantOnly }));
  return arm ?? hashArm(sessionId, rate);
}
