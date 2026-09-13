// Work-queue card types (W2a plan.md): a claimable unit of work, N candidates claim one row, first wins.
export type CardStatus = 'backlog' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'shelved';

const CARD_STATUSES: readonly CardStatus[] = ['backlog', 'ready', 'running', 'blocked', 'review', 'done', 'shelved'];

/** Narrows an unvalidated value (e.g. CLI input) to a CardStatus. */
export function isCardStatus(v: unknown): v is CardStatus {
  return typeof v === 'string' && (CARD_STATUSES as readonly string[]).includes(v);
}

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

export interface CardRun {
  id: number;
  card: string;
  runtime: string;
  sessionId: string | null;
  started: string;
  ended: string | null;
  outcome: string | null;
}

export interface CardComment {
  id: number;
  cardId: string;
  author: string;
  body: string;
  createdAt: string;
}

// The interface every write path calls (rule 15). One seam, no second copy.
export const CARD_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  backlog: ['ready'],
  ready: ['running'],
  running: ['blocked', 'review'],
  blocked: ['running'],
  review: ['done'],
  done: [],
  shelved: [],
};
