// hippo.db's Cards group: the agent work board.
import { loadCardDetailAt } from '../card-detail.js';
import {
  addCardCommentAt,
  blockCardAt,
  claimCardAt,
  completeCardAt,
  createCardAt,
  heartbeatCardAt,
  listCardsAt,
  loadCardAt,
  loadCardRunsAt,
  reclaimExpiredCardsAt,
  reviewCardAt,
} from '../cards.js';
import type { Cards } from '../port-groups.js';
import type { Sync } from '../port.js';
import type { OnHandle } from './open.js';
import { openStore } from './handles.js';

export function sqliteCards(on: OnHandle): Sync<Cards> {
  return {
    create: (tenantId, input) =>
      on(
        (db) => createCardAt(db, tenantId, { ...input, dependsOn: input.dependsOn ? [...input.dependsOn] : undefined }),
        openStore,
      ),
    load: (tenantId, id) => on((db) => loadCardAt(db, tenantId, id), openStore),
    detail: (tenantId, id) => on((db) => loadCardDetailAt(db, tenantId, id), openStore),
    list: (tenantId, opts) => on((db) => listCardsAt(db, tenantId, opts), openStore),
    runs: (tenantId, id) => on((db) => loadCardRunsAt(db, tenantId, id), openStore),
    claim: (tenantId, id, runtime, sessionId) =>
      on((db) => claimCardAt(db, tenantId, id, runtime, sessionId), openStore),
    heartbeat: (tenantId, id, runId) => on((db) => heartbeatCardAt(db, tenantId, id, runId), openStore),
    block: (tenantId, id, reason, runId) => on((db) => blockCardAt(db, tenantId, id, reason, runId), openStore),
    review: (tenantId, id, runId) => on((db) => reviewCardAt(db, tenantId, id, runId), openStore),
    complete: (tenantId, id, outcome, runId) => on((db) => completeCardAt(db, tenantId, id, outcome, runId), openStore),
    reclaimExpired: (tenantId) => on((db) => reclaimExpiredCardsAt(db, tenantId), openStore),
    comment: (tenantId, cardId, author, body) =>
      on((db) => addCardCommentAt(db, tenantId, cardId, author, body), openStore),
  };
}
