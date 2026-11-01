// The work board on hippo.db's local tier: each read and move runs on the caller's tenant's cards
// only; a move throws on an id the tenant holds no card under.
import type { Card, CardComment, CardStatus } from '../../base/records/card.js';
import type { CardCreate, CardDetail, CardPage } from '../../base/records/cards.js';
import type { HandoffOutcome } from '../../base/session/handoff.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_LIST_LIMIT } from '../../base/util/limits.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** Newest change first, a full list page at a time; `status` keeps one column of the board. */
export function boardPage(
  ctx: HippoDbContext,
  after?: KeysetPosition,
  status?: CardStatus,
): Promise<CardPage> {
  return ctx.store.hippoDb.cards.list(ctx.tenantId, { status, limit: MAX_LIST_LIMIT, after });
}

/** Null for an id the tenant holds no card under. */
export function cardDetail(ctx: HippoDbContext, id: string): Promise<CardDetail | null> {
  return ctx.store.hippoDb.cards.detail(ctx.tenantId, id);
}

export function createCard(ctx: HippoDbContext, input: CardCreate): Promise<Card> {
  return ctx.store.hippoDb.cards.create(ctx.tenantId, input);
}

/** Null when the card is neither ready nor blocked, or is already claimed. */
export function claimCard(
  ctx: HippoDbContext,
  id: string,
  runtime: string,
  sessionId?: string,
): Promise<(Card & { runId: number }) | null> {
  return ctx.store.hippoDb.cards.claim(ctx.tenantId, id, runtime, sessionId);
}

/** Null unless the card is running and `runId` is its live run. */
export function heartbeatCard(
  ctx: HippoDbContext,
  id: string,
  runId: number,
): Promise<Card | null> {
  return ctx.store.hippoDb.cards.heartbeat(ctx.tenantId, id, runId);
}

/** Null when the card is not running, or `runId` is not its live run. */
export function blockCard(
  ctx: HippoDbContext,
  id: string,
  reason: string,
  runId?: number,
): Promise<Card | null> {
  return ctx.store.hippoDb.cards.block(ctx.tenantId, id, reason, runId);
}

/** Null when the card is not running, or `runId` is not its live run. */
export function reviewCard(ctx: HippoDbContext, id: string, runId?: number): Promise<Card | null> {
  return ctx.store.hippoDb.cards.review(ctx.tenantId, id, runId);
}

/** Null when the card is not in review, or `runId` is not its live run; a success readies each
 * child whose parents are all done. */
export function completeCard(
  ctx: HippoDbContext,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): Promise<{ card: Card; promotedChildren: string[] } | null> {
  return ctx.store.hippoDb.cards.complete(ctx.tenantId, id, outcome, runId);
}

/** Every running card whose lease ran out or is missing goes back to ready; the ids reclaimed. */
export function reclaimExpiredCards(ctx: HippoDbContext): Promise<string[]> {
  return ctx.store.hippoDb.cards.reclaimExpired(ctx.tenantId);
}

export function commentOnCard(
  ctx: HippoDbContext,
  id: string,
  author: string,
  body: string,
): Promise<CardComment> {
  return ctx.store.hippoDb.cards.comment(ctx.tenantId, id, author, body);
}
