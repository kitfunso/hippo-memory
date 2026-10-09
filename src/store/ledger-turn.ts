// One hook or context turn's token-ledger work by store root: each call opens hippo.db, runs on one connection and closes it.
import type { DeliveryEventInput } from './delivery-recorder.js';
import { lastSentState, recordTokenUse, type LastSent, type TokenSurface, type TokenUse } from './token-ledger.js';
import { onHandle } from './open.js';
import { writeDeliveryEventOnHandle } from './recall-trace.js';

/** Stores one delivery event and returns its id, or null when the write failed. */
export type DeliveryWrite = (input: DeliveryEventInput) => number | null;

/** The token rows of one turn and the delivery event that follows them. */
export interface LedgerTurn {
  readonly uses: readonly TokenUse[];
  /** Makes each row its own attempt: a failed one is reported here and the rest still run. Without it the first failure throws. */
  readonly onRowError?: <E>(error: E) => void;
  /** Runs after the rows with a writer on their connection, so the delivery event costs no second open. */
  readonly delivery?: (write: DeliveryWrite) => void;
}

/** Books a turn's token rows, then its delivery event, on one connection. */
export function recordLedgerTurn(hippoRoot: string, turn: LedgerTurn): void {
  const { onRowError } = turn;
  onHandle(hippoRoot, (db) => {
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
  });
}

/** What the session last sent on `surface`, or null, as lastSentState reads it. */
export function lastSentOnSurface(
  hippoRoot: string, tenantId: string, sessionId: string | null | undefined, surface: TokenSurface,
): LastSent | null {
  return onHandle(hippoRoot, (db) => lastSentState(db, tenantId, sessionId, surface));
}
