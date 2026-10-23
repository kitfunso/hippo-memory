// The card shapes the Cards group returns.
import type { Card, CardComment, CardRun, CardStatus } from '../../base/records/card.js';
import type { SessionHandoff, HandoffOutcome } from '../../base/session/handoff.js';
import type { KeysetPosition } from '../../base/util/keyset.js';

/** The ids a card waits on and the ids that wait on it. */
interface CardDeps {
  parents: string[];
  children: string[];
}

/** A card plus everything `hippo card show` prints about it. */
export interface CardDetail {
  card: Card;
  deps: CardDeps;
  runs: CardRun[];
  comments: CardComment[];
  handoff: SessionHandoff | null;
}

export interface CardListQuery {
  readonly status?: CardStatus;
  readonly limit: number;
  /** Resume after this (updatedAt, id) position; the list runs newest change first. */
  readonly after?: KeysetPosition;
}

export interface CardPage {
  readonly cards: Card[];
  /** The position the next page starts after, or null when this page was the last. */
  readonly next: KeysetPosition | null;
}

export interface CardCreate {
  readonly title: string;
  readonly repo?: string;
  readonly contract?: string;
  readonly budget?: number;
  readonly dependsOn?: readonly string[];
}

export interface Cards {
  create(tenantId: string, input: CardCreate): Promise<Card>;
  load(tenantId: string, id: string): Promise<Card | null>;
  /** The card with its runs and comments, read together. */
  detail(tenantId: string, id: string): Promise<CardDetail | null>;
  /** One page of the tenant's cards, newest change first. */
  list(tenantId: string, query: CardListQuery): Promise<CardPage>;
  runs(tenantId: string, id: string): Promise<CardRun[]>;
  claim(tenantId: string, id: string, runtime: string, sessionId?: string): Promise<(Card & { runId: number }) | null>;
  heartbeat(tenantId: string, id: string, runId: number): Promise<Card | null>;
  block(tenantId: string, id: string, reason: string, runId?: number): Promise<Card | null>;
  review(tenantId: string, id: string, runId?: number): Promise<Card | null>;
  complete(
    tenantId: string,
    id: string,
    outcome: HandoffOutcome,
    runId?: number,
  ): Promise<{ card: Card; promotedChildren: string[] } | null>;
  /** Ids reclaimed. */
  reclaimExpired(tenantId: string): Promise<string[]>;
  comment(tenantId: string, cardId: string, author: string, body: string): Promise<CardComment>;
}
