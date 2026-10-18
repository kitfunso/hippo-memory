import { cardDetail } from '../../src/api/objects/cards.js';
import type { CardDetail } from '../../src/store/port/cards.js';
import { apiCtx } from './api-ctx.js';

/** What `hippo card show` prints for a card (deps, runs, comments, latest handoff), read through the api. */
export function cardDetailOf(root: string, tenantId: string, id: string): Promise<CardDetail | null> {
  return cardDetail(apiCtx(root, tenantId), id);
}
