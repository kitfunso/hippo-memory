// The agent work board: create, claim, review and complete cards, scoped to the caller's tenant.

import type { Card, CardComment, CardRun, CardStatus } from '../../core/card.js';
import type { HandoffOutcome } from '../../core/handoff.js';
import type { CardDetail } from '../../store/card-detail.js';
import type { CardCreate } from '../../store/index.js';
import type { ContextWith } from '../types.js';

type Ctx = ContextWith<'cards'>;

/** Create a card in the caller's tenant. Throws on an empty title or an unknown dependency. */
export function cardCreate(ctx: Ctx, input: CardCreate): Promise<Card> {
  return ctx.store.cards.create(ctx.tenantId, input);
}

/** One card by id, or null when the caller's tenant has none. */
export function cardLoad(ctx: Ctx, id: string): Promise<Card | null> {
  return ctx.store.cards.load(ctx.tenantId, id);
}

/** The card with its dependencies, runs, comments and latest handoff, or null when unknown. */
export function cardDetail(ctx: Ctx, id: string): Promise<CardDetail | null> {
  return ctx.store.cards.detail(ctx.tenantId, id);
}

/** The caller's cards, newest-updated first, optionally filtered to one status. */
export function cardList(ctx: Ctx, opts: { status?: CardStatus } = {}): Promise<Card[]> {
  return ctx.store.cards.list(ctx.tenantId, opts);
}

/** Every run of a card, newest first. */
export function cardRuns(ctx: Ctx, id: string): Promise<CardRun[]> {
  return ctx.store.cards.runs(ctx.tenantId, id);
}

/** Claim a ready or blocked card for a runtime; null when it cannot be claimed. */
export function cardClaim(
  ctx: Ctx,
  id: string,
  runtime: string,
  sessionId?: string,
): Promise<(Card & { runId: number }) | null> {
  return ctx.store.cards.claim(ctx.tenantId, id, runtime, sessionId);
}

/** Extend a live run's lease; null when the run is not live. */
export function cardHeartbeat(ctx: Ctx, id: string, runId: number): Promise<Card | null> {
  return ctx.store.cards.heartbeat(ctx.tenantId, id, runId);
}

/** Block a running card with a reason; null when it is not running. */
export function cardBlock(ctx: Ctx, id: string, reason: string, runId?: number): Promise<Card | null> {
  return ctx.store.cards.block(ctx.tenantId, id, reason, runId);
}

/** Move a running card to review; null when it is not running. */
export function cardReview(ctx: Ctx, id: string, runId?: number): Promise<Card | null> {
  return ctx.store.cards.review(ctx.tenantId, id, runId);
}

/** Complete a card in review and promote the children it unblocks; null when not in review. */
export function cardComplete(
  ctx: Ctx,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): Promise<{ card: Card; promotedChildren: string[] } | null> {
  return ctx.store.cards.complete(ctx.tenantId, id, outcome, runId);
}

/** Return every card with an expired lease to ready; yields the reclaimed ids. */
export function cardReclaimExpired(ctx: Ctx): Promise<string[]> {
  return ctx.store.cards.reclaimExpired(ctx.tenantId);
}

/** Add a comment to a card. Throws on an empty body. */
export function cardComment(ctx: Ctx, cardId: string, author: string, body: string): Promise<CardComment> {
  return ctx.store.cards.comment(ctx.tenantId, cardId, author, body);
}
