// hippo.db's token and delivery ledger: synchronous, since a hook books its turn on one connection before it exits.
import type { DeliveryEventInput } from './delivery.js';
import type { ApiCall, LastSent, TokenSurface, TokenUse } from './token-ledger.js';

export interface Ledger {
  /** The turn's token rows, then its delivery event, on one connection. */
  recordTurn(turn: LedgerTurn): void;
  /** One token row; throws, so the caller decides whether a ledger failure matters. */
  recordTokens(use: TokenUse): void;
  /** What the session last sent on `surface`, or null. */
  lastSent(tenantId: string, sessionId: string | null | undefined, surface: TokenSurface): LastSent | null;
  /** With `write`, books the session's arm as ensurePilotArm does; else the stored arm, or the hash arm. */
  pilotArm(
    tenantId: string,
    sessionId: string,
    rateBp: number,
    opts: { write: boolean; ownTenantOnly?: boolean },
  ): PilotArm;
  /** One delivery event on a short-lived handle; its id, or null when the write failed. */
  writeDeliveryEvent(input: DeliveryEventInput): number | null;
  /** Replaces the session's re-read rows from its transcript's calls; the tokens booked. */
  replaceRereads(tenantId: string, sessionId: string, calls: readonly ApiCall[]): number;
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

export type PilotArm = 'hippo' | 'holdout';
