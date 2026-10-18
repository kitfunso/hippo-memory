import { withReadSnapshot, type DatabaseSyncLike } from '../db/index.js';
import {
  loadCardCommentsAt,
  loadCardDepsAt,
  loadCardRow,
  loadCardRunsAt,
  loadLatestHandoffForCardAt,
} from './cards.js';
import { assertTenantId } from '../core/tenant-id.js';
import type { CardDetail } from './port/cards.js';

/** Loads the detail behind `hippo card show` and `GET /api/cards/:id` (null when the tenant has no such card), the five
 * reads on one snapshot. */
export function loadCardDetailAt(db: DatabaseSyncLike, tenantId: string, id: string): CardDetail | null {
  assertTenantId('loadCardDetail', tenantId);
  return withReadSnapshot(db, () => cardDetailAt(db, tenantId, id));
}

function cardDetailAt(db: DatabaseSyncLike, tenantId: string, id: string): CardDetail | null {
  const card = loadCardRow(db, tenantId, id);
  if (!card) return null;
  return {
    card,
    deps: loadCardDepsAt(db, tenantId, id),
    runs: loadCardRunsAt(db, tenantId, id),
    comments: loadCardCommentsAt(db, tenantId, id),
    handoff: loadLatestHandoffForCardAt(db, tenantId, id),
  };
}
