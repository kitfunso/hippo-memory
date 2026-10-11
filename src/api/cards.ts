// The agent work board: create, claim, review and complete cards, scoped to the caller's tenant.

import type { Card, CardComment, CardRun, CardStatus } from '../core/card.js';
import type { HandoffOutcome } from '../core/handoff.js';
import {
  addCardComment, blockCard, claimCard, completeCard, createCard, heartbeatCard,
  listCards, loadCard, loadCardRuns, reclaimExpiredCards, reviewCard,
} from '../store/cards.js';
import { loadCardDetail, type CardDetail } from '../store/card-detail.js';
import type { Context } from './types.js';

/** Create a card in the caller's tenant. Throws on an empty title or an unknown dependency. */
export function cardCreate(
  ctx: Context,
  input: { title: string; repo?: string; contract?: string; budget?: number; dependsOn?: string[] },
): Card {
  return createCard(ctx.hippoRoot, ctx.tenantId, input);
}

/** One card by id, or null when the caller's tenant has none. */
export function cardLoad(ctx: Context, id: string): Card | null {
  return loadCard(ctx.hippoRoot, ctx.tenantId, id);
}

/** The card with its dependencies, runs, comments and latest handoff, or null when unknown. */
export function cardDetail(ctx: Context, id: string): CardDetail | null {
  return loadCardDetail(ctx.hippoRoot, ctx.tenantId, id);
}

/** The caller's cards, newest-updated first, optionally filtered to one status. */
export function cardList(ctx: Context, opts: { status?: CardStatus } = {}): Card[] {
  return listCards(ctx.hippoRoot, ctx.tenantId, opts);
}

/** Every run of a card, newest first. */
export function cardRuns(ctx: Context, id: string): CardRun[] {
  return loadCardRuns(ctx.hippoRoot, ctx.tenantId, id);
}

/** Claim a ready or blocked card for a runtime; null when it cannot be claimed. */
export function cardClaim(
  ctx: Context,
  id: string,
  runtime: string,
  sessionId?: string,
): (Card & { runId: number }) | null {
  return claimCard(ctx.hippoRoot, ctx.tenantId, id, runtime, sessionId);
}

/** Extend a live run's lease; null when the run is not live. */
export function cardHeartbeat(ctx: Context, id: string, runId: number): Card | null {
  return heartbeatCard(ctx.hippoRoot, ctx.tenantId, id, runId);
}

/** Block a running card with a reason; null when it is not running. */
export function cardBlock(ctx: Context, id: string, reason: string, runId?: number): Card | null {
  return blockCard(ctx.hippoRoot, ctx.tenantId, id, reason, runId);
}

/** Move a running card to review; null when it is not running. */
export function cardReview(ctx: Context, id: string, runId?: number): Card | null {
  return reviewCard(ctx.hippoRoot, ctx.tenantId, id, runId);
}

/** Complete a card in review and promote the children it unblocks; null when not in review. */
export function cardComplete(
  ctx: Context,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): { card: Card; promotedChildren: string[] } | null {
  return completeCard(ctx.hippoRoot, ctx.tenantId, id, outcome, runId);
}

/** Return every card with an expired lease to ready; yields the reclaimed ids. */
export function cardReclaimExpired(ctx: Context): string[] {
  return reclaimExpiredCards(ctx.hippoRoot, ctx.tenantId);
}

/** Add a comment to a card. Throws on an empty body. */
export function cardComment(ctx: Context, cardId: string, author: string, body: string): CardComment {
  return addCardComment(ctx.hippoRoot, ctx.tenantId, cardId, author, body);
}
