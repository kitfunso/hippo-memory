// The card board's argument checks, run lookup and lease, once for both adapters, so a bad call fails with the same
// message under either store.
import { CARD_LEASE_MS } from '../../base/records/card.js';
import { isHandoffOutcome, type HandoffOutcome } from '../../base/session/handoff.js';
import type { CardCreate } from '../port/cards.js';

/** The lease a move to running or a heartbeat at `now` sets. */
export const leaseUntilFrom = (now: string): string => new Date(Date.parse(now) + CARD_LEASE_MS).toISOString();

export const unknownCard = (id: string): Error => new Error(`unknown card id: ${id}`);

export const unknownParentCard = (id: string): Error => new Error(`unknown parent card id: ${id}`);

/** Throws when the text argument `field` is blank. */
export function assertFilled(field: 'title' | 'runtime' | 'reason' | 'body', value: string): void {
  if (value.trim() === '') throw new Error(`${field} must not be empty`);
}

export function assertCardCreate(input: CardCreate): void {
  assertFilled('title', input.title);
  if (input.budget !== undefined && !(Number.isSafeInteger(input.budget) && input.budget > 0)) {
    throw new Error(`Invalid budget: ${input.budget} (expected a positive integer)`);
  }
}

export function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`Invalid run id: ${runId} (expected a positive integer)`);
  }
}

/** Throws on an outcome a caller outside TypeScript sent that is none of the handoff outcomes. */
export function assertCardOutcome(outcome: HandoffOutcome): void {
  if (!isHandoffOutcome(outcome)) throw new Error(`invalid card outcome: ${String(outcome)}`);
}

/** Whether `runId` is the card's run that has not ended. A second such run means a corrupt store, so this throws
 * rather than guess which run the caller means. */
export function isLiveRun(cardId: string, liveRunIds: readonly number[], runId: number): boolean {
  if (liveRunIds.length > 1) throw new Error(`card ${cardId} has ${liveRunIds.length} runs that have not ended`);
  return liveRunIds[0] === runId;
}
