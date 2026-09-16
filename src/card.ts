// Work-queue card types (W2a plan.md): a claimable unit of work, N candidates claim one row, first wins.
/** A work-queue card's lifecycle state; CARD_TRANSITIONS lists the legal moves between them. */
export type CardStatus = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'shelved';

const CARD_STATUSES: readonly CardStatus[] = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'shelved'];

/** Narrows a raw string, such as a CLI flag value, to a CardStatus. */
export function isCardStatus(v: string): v is CardStatus {
  return CARD_STATUSES.some((s) => s === v);
}

/** A card row; leaseUntil and heartbeatAt are null unless the card is running, and a card claimed under 1.40.0 runs with both null until a heartbeat sets them. */
export interface Card {
  id: string;
  title: string;
  status: CardStatus;
  assigneeRuntime: string | null;
  repo: string | null;
  contract: string | null;
  budget: number | null;
  leaseUntil: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  tenantId: string;
  scope: string | null;
}

/** One claim-to-close attempt at a card by a runtime. */
export interface CardRun {
  id: number;
  card: string;
  runtime: string;
  sessionId: string | null;
  started: string;
  ended: string | null;
  outcome: string | null;
}

/** A comment left on a card. */
export interface CardComment {
  id: number;
  cardId: string;
  author: string;
  body: string;
  createdAt: string;
}

/** The legal next-statuses for each CardStatus. */
export type CardTransitions = { readonly [S in CardStatus]: readonly CardStatus[] };

/** transitionCard checks every status write against this map. */
export const CARD_TRANSITIONS: CardTransitions = {
  backlog: ['ready'],
  ready: ['running'],
  running: ['blocked', 'review', 'ready'],
  blocked: ['running'],
  review: ['done', 'shelved'],
  done: [],
  shelved: [],
};

// SHORTCUT: one fixed lease for every claim; add a per-claim lease when the W3 dispatcher heartbeats on a timer.
/** How long a claim or a heartbeat keeps a running card's lease before reclaimExpiredCards may return it to ready. */
export const CARD_LEASE_MS = 4 * 60 * 60 * 1000;
