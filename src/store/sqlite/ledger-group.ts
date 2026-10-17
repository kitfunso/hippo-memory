// hippo.db's Ledger: each call runs on the request's handle or a short-lived one. The delivery write and the re-read
// rows keep their root forms, which own their lock waits.
import { pilotArmAt, recordLedgerTurnAt } from '../ledger-turn.js';
import { onHandle } from '../open.js';
import type { Ledger } from '../port/ledger.js';
import { writeDeliveryEventAtRoot } from '../recall-trace.js';
import { lastSentState, recordRereads, recordTokenUse } from '../token-ledger.js';

export function sqliteLedger(hippoRoot: string): Ledger {
  return {
    recordTurn: (turn) => onHandle(hippoRoot, (db) => recordLedgerTurnAt(db, turn)),
    recordTokens: (use) => onHandle(hippoRoot, (db) => recordTokenUse(db, use)),
    lastSent: (tenantId, sessionId, surface) =>
      onHandle(hippoRoot, (db) => lastSentState(db, tenantId, sessionId, surface)),
    pilotArm: (tenantId, sessionId, rateBp, opts) =>
      onHandle(hippoRoot, (db) => pilotArmAt(db, tenantId, sessionId, rateBp, opts)),
    writeDeliveryEvent: (input) => writeDeliveryEventAtRoot(hippoRoot, input),
    replaceRereads: (tenantId, sessionId, calls) => recordRereads(hippoRoot, tenantId, sessionId, calls),
  };
}
