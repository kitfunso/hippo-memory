import type { Card, CardComment, CardRun } from '../core/card.js';
import { withReadSnapshot, type DatabaseSyncLike } from '../db/index.js';
import type { SessionHandoff } from '../core/handoff.js';
import {
  loadCardCommentsAt, loadCardDepsAt, loadCardRow, loadCardRunsAt, loadLatestHandoffForCardAt,
} from './cards.js';
import { onHandle, openStore } from './open.js';
import { assertTenantId } from './tenant.js';

/** A card plus everything `hippo card show` prints about it. */
export interface CardDetail {
  card: Card;
  deps: ReturnType<typeof loadCardDepsAt>;
  runs: CardRun[];
  comments: CardComment[];
  handoff: SessionHandoff | null;
}

/** Loads the detail behind `hippo card show` and `GET /api/cards/:id` (null when the tenant has no such card), the five
 * reads on one snapshot. */
export function loadCardDetail(hippoRoot: string, tenantId: string, id: string): CardDetail | null {
  assertTenantId('loadCardDetail', tenantId);
  return onHandle(hippoRoot, (db) => withReadSnapshot(db, () => cardDetailAt(db, tenantId, id)), openStore);
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
