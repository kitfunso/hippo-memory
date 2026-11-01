// hippo.db's Cards group, the agent work board: create, list, detail and the comment write.

import { generateId } from '../../../base/memory/entry.js';
import { withWriteScope, type DatabaseSyncLike, withReadSnapshot } from '../../../db/index.js';
import { SessionHandoff, rowToSessionHandoff } from '../../../base/session/handoff.js';
import { Card, CardStatus, CardRun, CardComment } from '../../../base/records/card.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import { HANDOFF_COLUMNS, type SessionHandoffDbRow } from '../sessions/handoffs.js';
import type {
  CardDetail,
  CardCreate,
  CardListQuery,
  CardPage,
  Cards,
} from '../../../base/records/cards.js';
import { keysetPage } from '../../../base/util/keyset.js';
import type { OnHandle } from '../runtime/open.js';
import { openStore } from '../runtime/handles.js';
import { bound, type Bodies } from '../runtime/bound.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { handleStamp } from '../runtime/handle-clock.js';
import {
  CARD_COLUMNS,
  assertFilled,
  insertCardComment,
  readCardRow,
  rowToCard,
  rowToCardComment,
  rowToCardRun,
  type CardCommentRow,
  type CardRow,
  type CardRunRow,
} from './card-rows.js';
import {
  blockCard,
  claimCard,
  completeCard,
  heartbeatCard,
  reclaimExpiredCards,
  reviewCard,
} from './card-runs.js';

const unknownParentCard = (id: string): Error => new Error(`unknown parent card id: ${id}`);

function assertCardCreate(input: CardCreate): void {
  assertFilled('title', input.title);
  if (input.budget !== undefined && !(Number.isSafeInteger(input.budget) && input.budget > 0)) {
    throw new Error(`Invalid budget: ${input.budget} (expected a positive integer)`);
  }
}

/** Creates a card; status is ready with no deps or once every dependsOn id is done, else backlog.
 * An unknown dependsOn id throws and commits nothing. A repeated dependsOn id is recorded once. */
function createCard(db: DatabaseSyncLike, tenantId: string, input: CardCreate): Card {
  assertTenantId('createCard', tenantId);
  assertCardCreate(input);
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  let id = '';

  withWriteScope(db, 'create_card', () => {
    // Probe runs inside the transaction (mirrors batchWriteAndDelete): a parent completing between
    // an outside-the-lock read and the INSERT would strand the child.
    const allParentsDone = everyParentDone(db, tenantId, dependsOn);

    id = generateId('card');
    const now = handleStamp(db);
    const status: CardStatus = dependsOn.length === 0 || allParentsDone ? 'ready' : 'backlog';

    cachedStatement(
      db,
      `
      INSERT INTO cards (id, title, status, repo, contract, budget, created_at, updated_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      input.title,
      status,
      input.repo ?? null,
      input.contract ?? null,
      input.budget ?? null,
      now,
      now,
      tenantId,
    );
    const insertDep = cachedStatement(
      db,
      `
      INSERT INTO card_deps (parent, child, tenant_id, created_at) VALUES (?, ?, ?, ?)
    `,
    );
    for (const parentId of dependsOn) insertDep.run(parentId, id, tenantId, now);
  });
  return readCardRow(db, tenantId, id)!;
}

/** Whether every dependsOn card is done, true for none; throws on an id that is no card of the
 * tenant. Call inside the write scope. */
function everyParentDone(
  db: DatabaseSyncLike,
  tenantId: string,
  dependsOn: readonly string[],
): boolean {
  if (dependsOn.length === 0) return true;
  const rows = cachedStatement(
    db,
    `SELECT id, status FROM cards WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))`,
  ).all(tenantId, JSON.stringify(dependsOn)) as Array<{ id: string; status: string }>;
  const found = new Map(rows.map((r) => [r.id, r.status]));
  // Pre-check before any write: a typo'd --depends-on can never commit a card row.
  for (const parentId of dependsOn) {
    if (!found.has(parentId)) {
      throw unknownParentCard(parentId);
    }
  }
  return dependsOn.every((pid) => found.get(pid) === 'done');
}

/** One page of the tenant's cards, optionally of one status, newest-updated first. */
function listCards(
  db: DatabaseSyncLike,
  tenantId: string,
  { status, limit, after }: CardListQuery,
): CardPage {
  assertTenantId('listCards', tenantId);
  const conditions = ['tenant_id = ?'];
  const params: Array<string | number> = [tenantId];
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (after) {
    conditions.push('(updated_at, id) < (?, ?)');
    params.push(after.key, after.id);
  }
  const rows = cachedStatement(
    db,
    `SELECT ${CARD_COLUMNS} FROM cards WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(...params, limit + 1) as CardRow[];
  const page = keysetPage(rows.map(rowToCard), limit, (card) => ({
    key: card.updatedAt,
    id: card.id,
  }));
  return { cards: page.rows, next: page.next };
}

function listCardDeps(db: DatabaseSyncLike, tenantId: string, id: string) {
  const parents = (
    cachedStatement(db, `SELECT parent FROM card_deps WHERE tenant_id = ? AND child = ?`).all(
      tenantId,
      id,
    ) as Array<{
      parent: string;
    }>
  ).map((r) => r.parent);
  const children = (
    cachedStatement(db, `SELECT child FROM card_deps WHERE tenant_id = ? AND parent = ?`).all(
      tenantId,
      id,
    ) as Array<{
      child: string;
    }>
  ).map((r) => r.child);
  return { parents, children };
}

function listCardRuns(db: DatabaseSyncLike, tenantId: string, id: string): CardRun[] {
  const rows = cachedStatement(
    db,
    `
    SELECT id, card, runtime, session_id, started, ended, outcome
    FROM card_runs WHERE tenant_id = ? AND card = ? ORDER BY started DESC, id DESC
  `,
  ).all(tenantId, id) as CardRunRow[];
  return rows.map(rowToCardRun);
}

function listCardComments(db: DatabaseSyncLike, tenantId: string, id: string): CardComment[] {
  const rows = cachedStatement(
    db,
    `
    SELECT id, card_id, author, body, created_at
    FROM card_comments WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC, id DESC
  `,
  ).all(tenantId, id) as CardCommentRow[];
  return rows.map(rowToCardComment);
}

function readLatestHandoffForCard(
  db: DatabaseSyncLike,
  tenantId: string,
  cardId: string,
): SessionHandoff | null {
  const row = cachedStatement(
    db,
    `
    SELECT ${HANDOFF_COLUMNS} FROM session_handoffs
    WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `,
  ).get(tenantId, cardId) as SessionHandoffDbRow | undefined;
  return row ? rowToSessionHandoff(row) : null;
}

/** Appends a comment to cardId in any card status; throws if cardId is not a card of
 * this tenant. */
function addCardComment(
  db: DatabaseSyncLike,
  tenantId: string,
  cardId: string,
  author: string,
  body: string,
): CardComment {
  assertTenantId('addCardComment', tenantId);
  assertFilled('body', body);
  return insertCardComment(db, { tenantId, cardId, author, body });
}

/** Loads the detail behind `hippo card show` and `GET /api/cards/:id` (null when the tenant has
 * no such card), the five reads on one snapshot. */
function readCardDetail(db: DatabaseSyncLike, tenantId: string, id: string): CardDetail | null {
  assertTenantId('readCardDetail', tenantId);
  return withReadSnapshot(db, () => cardDetail(db, tenantId, id));
}

function cardDetail(db: DatabaseSyncLike, tenantId: string, id: string): CardDetail | null {
  const card = readCardRow(db, tenantId, id);
  if (!card) return null;
  return {
    card,
    deps: listCardDeps(db, tenantId, id),
    runs: listCardRuns(db, tenantId, id),
    comments: listCardComments(db, tenantId, id),
    handoff: readLatestHandoffForCard(db, tenantId, id),
  };
}

const cardsBodies: Bodies<Cards> = {
  create: createCard,
  detail: readCardDetail,
  list: listCards,
  claim: claimCard,
  heartbeat: heartbeatCard,
  block: blockCard,
  review: reviewCard,
  complete: completeCard,
  reclaimExpired: reclaimExpiredCards,
  comment: addCardComment,
};

export function sqliteCards(on: OnHandle): Cards {
  return bound(on, cardsBodies, openStore);
}
