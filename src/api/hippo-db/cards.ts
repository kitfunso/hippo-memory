// The Board's reads of the caller's tenant's cards, on hippo.db's local tier.
import type { CardDetail, CardPage } from '../../base/records/cards.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_LIST_LIMIT } from '../../base/util/limits.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** Newest change first, a full list page at a time. */
export function boardPage(ctx: HippoDbContext, after?: KeysetPosition): Promise<CardPage> {
  return ctx.store.hippoDb.cards.list(ctx.tenantId, { limit: MAX_LIST_LIMIT, after });
}

/** Null for an id the tenant holds no card under. */
export function cardDetail(ctx: HippoDbContext, id: string): Promise<CardDetail | null> {
  return ctx.store.hippoDb.cards.detail(ctx.tenantId, id);
}
