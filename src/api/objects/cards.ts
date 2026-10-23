// The agent work board: create, claim, review and complete cards, scoped to the caller's tenant.

import type { Card, CardComment, CardRun, CardStatus } from '../../base/records/card.js';
import type { HandoffOutcome } from '../../base/session/handoff.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_LIST_LIMIT } from '../../base/util/limits.js';
import type { CardDetail, CardCreate, CardPage } from '../../store/port/cards.js';
import { keysetPages, pageLimit } from '../pages.js';
import type { Context } from '../types.js';

/** Create a card in the caller's tenant. Throws on an empty title or an unknown dependency. */
export function cardCreate(ctx: Context, input: CardCreate): Promise<Card> {
  return ctx.store.cards.create(ctx.tenantId, input);
}

/** One card by id, or null when the caller's tenant has none. */
export function cardLoad(ctx: Context, id: string): Promise<Card | null> {
  return ctx.store.cards.load(ctx.tenantId, id);
}

/** The card with its dependencies, runs, comments and latest handoff, or null when unknown. */
export function cardDetail(ctx: Context, id: string): Promise<CardDetail | null> {
  return ctx.store.cards.detail(ctx.tenantId, id);
}

export interface CardPageOptions {
  status?: CardStatus;
  limit?: number;
  after?: KeysetPosition;
}

/** One page of the caller's cards, newest-updated first, optionally of one status. */
export function cardList(ctx: Context, opts: CardPageOptions = {}): Promise<CardPage> {
  const { status, after } = opts;
  return ctx.store.cards.list(ctx.tenantId, { status, limit: pageLimit(opts.limit), after });
}

/** Every page of the caller's cards in list order, the largest page at a time, for the verbs that print them all. */
export async function* cardPages(ctx: Context, status?: CardStatus): AsyncGenerator<Card[]> {
  for await (const page of keysetPages((after) => cardList(ctx, { status, limit: MAX_LIST_LIMIT, after }))) {
    yield page.cards;
  }
}

/** Every run of a card, newest first. */
export function cardRuns(ctx: Context, id: string): Promise<CardRun[]> {
  return ctx.store.cards.runs(ctx.tenantId, id);
}

/** Claim a ready or blocked card for a runtime; null when it cannot be claimed. */
export function cardClaim(
  ctx: Context,
  id: string,
  runtime: string,
  sessionId?: string,
): Promise<(Card & { runId: number }) | null> {
  return ctx.store.cards.claim(ctx.tenantId, id, runtime, sessionId);
}

/** Extend a live run's lease; null when the run is not live. */
export function cardHeartbeat(ctx: Context, id: string, runId: number): Promise<Card | null> {
  return ctx.store.cards.heartbeat(ctx.tenantId, id, runId);
}

/** Block a running card with a reason; null when it is not running. */
export function cardBlock(ctx: Context, id: string, reason: string, runId?: number): Promise<Card | null> {
  return ctx.store.cards.block(ctx.tenantId, id, reason, runId);
}

/** Move a running card to review; null when it is not running. */
export function cardReview(ctx: Context, id: string, runId?: number): Promise<Card | null> {
  return ctx.store.cards.review(ctx.tenantId, id, runId);
}

/** Complete a card in review and promote the children it unblocks; null when not in review. */
export function cardComplete(
  ctx: Context,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): Promise<{ card: Card; promotedChildren: string[] } | null> {
  return ctx.store.cards.complete(ctx.tenantId, id, outcome, runId);
}

/** Return every card with an expired lease to ready; yields the reclaimed ids. */
export function cardReclaimExpired(ctx: Context): Promise<string[]> {
  return ctx.store.cards.reclaimExpired(ctx.tenantId);
}

/** Add a comment to a card. Throws on an empty body. */
export function cardComment(ctx: Context, cardId: string, author: string, body: string): Promise<CardComment> {
  return ctx.store.cards.comment(ctx.tenantId, cardId, author, body);
}
