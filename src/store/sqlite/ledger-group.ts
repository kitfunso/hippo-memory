// hippo.db's Ledger: each call runs on the request's handle or a short-lived one. The delivery write takes the opener,
// since it is fail-soft on an open that fails.
import { pilotArmAt, recordLedgerTurnAt } from '../ledger-turn.js';
import type { OnHandle } from '../open.js';
import type { Ledger } from '../port/ledger.js';
import { deliveryPruneSchedule, writeDeliveryEventVia } from '../recall-trace.js';
import { lastSentState, recordRereadsAt, recordTokenUse } from '../token-ledger.js';

export function sqliteLedger(on: OnHandle): Ledger {
  // One schedule per store, so a long-lived server prunes the delivery ledger once a minute, not on every event.
  const prune = deliveryPruneSchedule();
  return {
    recordTurn: (turn) => on((db) => recordLedgerTurnAt(db, turn, prune)),
    recordTokens: (use) => on((db) => recordTokenUse(db, use)),
    lastSent: (tenantId, sessionId, surface) => on((db) => lastSentState(db, tenantId, sessionId, surface)),
    pilotArm: (tenantId, sessionId, rateBp, opts) => on((db) => pilotArmAt(db, tenantId, sessionId, rateBp, opts)),
    writeDeliveryEvent: (input) => writeDeliveryEventVia(on, input, prune),
    replaceRereads: (tenantId, sessionId, calls) => on((db) => recordRereadsAt(db, tenantId, sessionId, calls)),
  };
}
