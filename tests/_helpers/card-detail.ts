import type { CardDetail } from '../../src/base/records/cards.js';
import { apiCtx } from './api-ctx.js';

/** What `hippo card show` prints for a card (deps, runs, comments, latest handoff), read through the api. */
export function cardDetailOf(root: string, tenantId: string, id: string): Promise<CardDetail | null> {
  const ctx = apiCtx(root, tenantId);
  return ctx.store.hippoDb.cards.detail(ctx.tenantId, id);
}
