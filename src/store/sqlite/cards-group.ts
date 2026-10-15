// hippo.db's Cards group: the agent work board.
import { loadCardDetail } from '../card-detail.js';
import {
  addCardComment, blockCard, claimCard, completeCard, createCard, heartbeatCard, listCards, loadCard, loadCardRuns,
  reclaimExpiredCards, reviewCard,
} from '../cards.js';
import type { Cards } from '../port-groups.js';
import type { Sync } from '../port.js';

export function sqliteCards(hippoRoot: string): Sync<Cards> {
  return {
    create: (tenantId, input) =>
      createCard(hippoRoot, tenantId, { ...input, dependsOn: input.dependsOn ? [...input.dependsOn] : undefined }),
    load: (tenantId, id) => loadCard(hippoRoot, tenantId, id),
    detail: (tenantId, id) => loadCardDetail(hippoRoot, tenantId, id),
    list: (tenantId, opts) => listCards(hippoRoot, tenantId, opts),
    runs: (tenantId, id) => loadCardRuns(hippoRoot, tenantId, id),
    claim: (tenantId, id, runtime, sessionId) => claimCard(hippoRoot, tenantId, id, runtime, sessionId),
    heartbeat: (tenantId, id, runId) => heartbeatCard(hippoRoot, tenantId, id, runId),
    block: (tenantId, id, reason, runId) => blockCard(hippoRoot, tenantId, id, reason, runId),
    review: (tenantId, id, runId) => reviewCard(hippoRoot, tenantId, id, runId),
    complete: (tenantId, id, outcome, runId) => completeCard(hippoRoot, tenantId, id, outcome, runId),
    reclaimExpired: (tenantId) => reclaimExpiredCards(hippoRoot, tenantId),
    comment: (tenantId, cardId, author, body) => addCardComment(hippoRoot, tenantId, cardId, author, body),
  };
}

/** The group as a served store answers it: a throw rejects as another store's would. */
export function servedCards(sync: Sync<Cards>): Cards {
  return {
    create: async (tenantId, input) => sync.create(tenantId, input),
    load: async (tenantId, id) => sync.load(tenantId, id),
    detail: async (tenantId, id) => sync.detail(tenantId, id),
    list: async (tenantId, opts) => sync.list(tenantId, opts),
    runs: async (tenantId, id) => sync.runs(tenantId, id),
    claim: async (tenantId, id, runtime, sessionId) => sync.claim(tenantId, id, runtime, sessionId),
    heartbeat: async (tenantId, id, runId) => sync.heartbeat(tenantId, id, runId),
    block: async (tenantId, id, reason, runId) => sync.block(tenantId, id, reason, runId),
    review: async (tenantId, id, runId) => sync.review(tenantId, id, runId),
    complete: async (tenantId, id, outcome, runId) => sync.complete(tenantId, id, outcome, runId),
    reclaimExpired: async (tenantId) => sync.reclaimExpired(tenantId),
    comment: async (tenantId, cardId, author, body) => sync.comment(tenantId, cardId, author, body),
  };
}
