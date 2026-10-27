// Card rows: the columns, the row mappers and the comment insert that card reads and writes share.

import { type DatabaseSyncLike } from '../../db/index.js';
import { Card, CardStatus, CardRun, CardComment } from '../../base/records/card.js';
import { cachedStatement } from '../../db/statement-cache.js';
import { handleStamp } from './handle-clock.js';

export const unknownCard = (id: string): Error => new Error(`unknown card id: ${id}`);

/** Throws when the text argument `field` is blank. */
export function assertFilled(field: 'title' | 'runtime' | 'reason' | 'body', value: string): void {
  if (value.trim() === '') throw new Error(`${field} must not be empty`);
}

// SAFETY: every read cast to this row selects CARD_COLUMNS; scripts/check-row-casts.mjs proves it.
// The status column only ever holds a CardStatus value.
export interface CardRow {
  id: string;
  title: string;
  status: CardStatus;
  assignee_runtime: string | null;
  repo: string | null;
  contract: string | null;
  budget: number | null;
  lease_until: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
  tenant_id: string;
  scope: string | null;
}

export const CARD_COLUMNS =
  'id, title, status, assignee_runtime, repo, contract, budget, lease_until, heartbeat_at, created_at, updated_at, ' +
  'tenant_id, scope';

export function rowToCard(row: CardRow): Card {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigneeRuntime: row.assignee_runtime,
    repo: row.repo,
    contract: row.contract,
    budget: row.budget,
    leaseUntil: row.lease_until,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tenantId: row.tenant_id,
    scope: row.scope,
  };
}

export function readCardRow(db: DatabaseSyncLike, tenantId: string, id: string): Card | null {
  const row = cachedStatement(
    db,
    `SELECT ${CARD_COLUMNS} FROM cards WHERE id = ? AND tenant_id = ?`,
  ).get(id, tenantId) as CardRow | undefined;
  return row ? rowToCard(row) : null;
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface CardRunRow {
  id: number;
  card: string;
  runtime: string;
  session_id: string | null;
  started: string;
  ended: string | null;
  outcome: string | null;
}

export function rowToCardRun(row: CardRunRow): CardRun {
  return {
    id: row.id,
    card: row.card,
    runtime: row.runtime,
    sessionId: row.session_id,
    started: row.started,
    ended: row.ended,
    outcome: row.outcome,
  };
}

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export interface CardCommentRow {
  id: number;
  card_id: string;
  author: string;
  body: string;
  created_at: string;
}

export function rowToCardComment(row: CardCommentRow): CardComment {
  return {
    id: row.id,
    cardId: row.card_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** A tenant's card and the comment its author leaves on it. */
interface CardCommentOptions {
  readonly tenantId: string;
  readonly cardId: string;
  readonly author: string;
  readonly body: string;
}

export function insertCardComment(
  db: DatabaseSyncLike,
  { tenantId, cardId, author, body }: CardCommentOptions,
): CardComment {
  const now = handleStamp(db);
  const result = cachedStatement(
    db,
    `
    INSERT INTO card_comments (card_id, author, body, created_at, tenant_id)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND tenant_id = ?)
  `,
  ).run(cardId, author, body, now, tenantId, cardId, tenantId);
  if (Number(result.changes ?? 0) === 0) {
    throw unknownCard(cardId);
  }
  const id = Number(result.lastInsertRowid ?? 0);
  return { id, cardId, author, body, createdAt: now };
}
