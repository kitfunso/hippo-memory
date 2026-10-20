// The token and delivery ledger as a port group. A hook books its turn here, so every call but replaceRereads is best
// effort: a row that does not land is noted at the level its cause earns and never rejects.
import type { PilotArm } from '../../base/session/pilot-arm.js';
import type { DeliveryEventInput } from '../../base/session/delivery.js';
import type { LastSent } from '../../base/session/skip-unchanged.js';
import type { ApiCall } from '../../base/session/transcript-calls.js';
import type { TokenSurface, TokenUse } from './token-ledger.js';

export interface Ledger {
  /** The turn's token rows, then its delivery event, on one connection. */
  recordTurn(turn: LedgerTurn): Promise<void>;
  /** What the session last sent on `surface`; null with none, or when the read failed. */
  lastSent(tenantId: string, sessionId: string | null | undefined, surface: TokenSurface): Promise<LastSent | null>;
  /** With `write`, books the session's arm unless one is stored; else the stored arm. The hash arm when neither. */
  pilotArm(tenantId: string, sessionId: string, rateBp: number, opts: PilotArmOptions): Promise<PilotArm>;
  /** One delivery event; its id, or null when the write failed. */
  writeDeliveryEvent(input: DeliveryEventInput): Promise<number | null>;
  /** Replaces the session's re-read rows from its transcript's calls; the tokens booked.
   * Rejects when the write fails. */
  replaceRereads(tenantId: string, sessionId: string, calls: readonly ApiCall[]): Promise<number>;
}

export interface PilotArmOptions {
  readonly write: boolean;
  /** Only the caller tenant's arm row counts. */
  readonly ownTenantOnly?: boolean;
}

/** The token rows of one turn and the delivery event that follows them. */
export interface LedgerTurn {
  readonly uses: readonly TokenUse[];
  /** Each row its own attempt, so one that fails leaves the rest; without it the first failure ends the rows. */
  readonly perRow?: boolean;
  /** Written after the rows, whatever became of them. */
  readonly delivery?: DeliveryEventInput;
}
