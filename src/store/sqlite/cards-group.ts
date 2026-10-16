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
