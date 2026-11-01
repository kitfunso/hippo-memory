// The card run lifecycle: claim, heartbeat, block, review, complete and reclaim, with their run checks.

import {
  changedRows,
  withWriteScope,
  withWriteScopeOr,
  type DatabaseSyncLike,
} from '../../../db/index.js';
import { HandoffOutcome, isHandoffOutcome } from '../../../base/session/handoff.js';
import {
  Card,
  CardStatus,
  assertCardTransition,
  CARD_LEASE_MS,
} from '../../../base/records/card.js';
import { assertTenantId } from '../../../base/scope/tenant-id.js';
import { chunked } from '../../../base/util/chunked.js';
import { placeholders } from '../../../db/sql.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import { handleStamp } from '../runtime/handle-clock.js';
import { assertFilled, insertCardComment, readCardRow, unknownCard } from './card-rows.js';

/** The lease a move to running or a heartbeat at `now` sets. */
const leaseUntilFrom = (now: string): string =>
  new Date(Date.parse(now) + CARD_LEASE_MS).toISOString();

function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`Invalid run id: ${runId} (expected a positive integer)`);
  }
}

/** Throws on an outcome a caller outside TypeScript sent that is none of the handoff outcomes. */
function assertCardOutcome(outcome: HandoffOutcome): void {
  if (!isHandoffOutcome(outcome)) throw new Error(`invalid card outcome: ${String(outcome)}`);
}

/** Whether `runId` is the card's run that has not ended. A second such run means a corrupt
 * store, so this throws rather than guess which run the caller means. */
function isLiveRun(cardId: string, liveRunIds: readonly number[], runId: number): boolean {
  if (liveRunIds.length > 1) {
    throw new Error(`card ${cardId} has ${liveRunIds.length} runs that have not ended`);
  }
  return liveRunIds[0] === runId;
}

function liveRunIs(db: DatabaseSyncLike, tenantId: string, cardId: string, runId: number): boolean {
  const rows = cachedStatement(
    db,
    `SELECT id FROM card_runs WHERE tenant_id = ? AND card = ? AND ended IS NULL`,
  ).all(tenantId, cardId) as Array<{ id: number }>;
  return isLiveRun(
    cardId,
    rows.map((row) => row.id),
    runId,
  );
}

/** A tenant's card, how its live run ended and when. */
interface CloseRunOptions {
  readonly tenantId: string;
  readonly cardId: string;
  readonly outcome: string;
  readonly now: string;
}

function closeLiveRun(
  db: DatabaseSyncLike,
  { tenantId, cardId, outcome, now }: CloseRunOptions,
): void {
  cachedStatement(
    db,
    `
    UPDATE card_runs SET ended = ?, outcome = ?, updated_at = ?
    WHERE card = ? AND tenant_id = ? AND ended IS NULL
  `,
  ).run(now, outcome, now, cardId, tenantId);
}

// Every card status change goes through this one function. CARD_TRANSITIONS is the only source of
// allowed moves, so a hand-copied wrong `from` list fails fast here.
interface TransitionCardOptions {
  readonly from: CardStatus[];
  readonly to: CardStatus;
  readonly extra?: { setSql?: string; whereSql?: string; params?: unknown[] };
}

function transitionCard(
  db: DatabaseSyncLike,
  tenantId: string,
  cardId: string,
  options: TransitionCardOptions,
): number {
  return transitionCards(db, tenantId, [cardId], options);
}

/** transitionCard for every card in `cardIds`, as one statement with one timestamp; returns how
 * many moved. */
function transitionCards(
  db: DatabaseSyncLike,
  tenantId: string,
  cardIds: readonly string[],
  options: TransitionCardOptions,
): number {
  const { from, to, extra } = options;
  assertCardTransition(from, to);
  const now = handleStamp(db);
  // Lease columns follow status: set on the move to running, cleared on every other move, so the
  // lease never outlives the status.
  const lease = to === 'running' ? [leaseUntilFrom(now), now] : [null, null];
  const fromPlaceholders = placeholders(from.length);
  const sql = `
    UPDATE cards SET status = ?, updated_at = ?, lease_until = ?, heartbeat_at =
    ?${extra?.setSql ? `, ${extra.setSql}` : ''}
    WHERE id IN (SELECT value FROM json_each(?)) AND tenant_id = ? AND status IN
    (${fromPlaceholders})${extra?.whereSql ? ` AND ${extra.whereSql}` : ''}
  `;
  const params: unknown[] = [
    to,
    now,
    ...lease,
    ...(extra?.params ?? []),
    JSON.stringify(cardIds),
    tenantId,
    ...from,
  ];
  const result = cachedStatement(db, sql).run(...params);
  return changedRows(result);
}

/** Atomic claim: WHERE status IN (ready, blocked) AND assignee_runtime IS NULL decides the race.
 * Throws on an unknown card id; returns null for a card not ready/blocked or already claimed.
 * Sets a CARD_LEASE_MS lease and returns the new run's id as runId. */
export function claimCardRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  runtime: string,
  sessionId?: string,
): (Card & { runId: number }) | null {
  assertTenantId('claimCardRow', tenantId);
  assertFilled('runtime', runtime);
  const runId = withWriteScopeOr(db, 'claim_card', (rollback) => {
    const changes = transitionCard(db, tenantId, id, {
      from: ['ready', 'blocked'],
      to: 'running',
      extra: {
        setSql: 'assignee_runtime = ?',
        whereSql: 'assignee_runtime IS NULL',
        params: [runtime],
      },
    });
    if (changes === 0) {
      if (!readCardRow(db, tenantId, id)) {
        throw unknownCard(id);
      }
      return rollback(null);
    }
    const now = handleStamp(db);
    const insert = cachedStatement(
      db,
      `
    INSERT INTO card_runs (card, runtime, session_id, started, created_at, updated_at, tenant_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    ).run(id, runtime, sessionId ?? null, now, now, now, tenantId);
    return Number(insert.lastInsertRowid ?? 0);
  });
  return runId === null ? null : { ...readCardRow(db, tenantId, id)!, runId };
}

/** Moves a running card's lease to CARD_LEASE_MS from now and records the heartbeat; updated_at
 * is left alone. Throws on an unknown card id or a run id that is not a positive integer;
 * returns null unless the card is running and runId is its live run. */
export function heartbeatCardRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  runId: number,
): Card | null {
  assertTenantId('heartbeatCardRow', tenantId);
  assertRunId(runId);
  const beat = withWriteScopeOr(db, 'heartbeat_card', (rollback) => {
    const card = readCardRow(db, tenantId, id);
    if (!card) {
      throw unknownCard(id);
    }
    if (card.status !== 'running' || !liveRunIs(db, tenantId, id, runId)) {
      return rollback(false);
    }
    const now = handleStamp(db);
    cachedStatement(
      db,
      `UPDATE cards SET lease_until = ?, heartbeat_at = ? WHERE id = ? AND tenant_id = ?`,
    ).run(leaseUntilFrom(now), now, id, tenantId);
    return true;
  });
  return beat ? readCardRow(db, tenantId, id) : null;
}

/** Requires the card be running; closes the live run as blocked and files reason as a comment.
 * Throws on an unknown card id; returns null for a card not running. When runId is given,
 * returns null unless it is the card's live run. */
export function blockCardRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  reason: string,
  runId?: number,
): Card | null {
  assertTenantId('blockCardRow', tenantId);
  assertFilled('reason', reason);
  if (runId !== undefined) assertRunId(runId);
  const blocked = withWriteScopeOr(db, 'block_card', (rollback) => {
    const allowed = runId === undefined || liveRunIs(db, tenantId, id, runId);
    const changes = allowed
      ? transitionCard(db, tenantId, id, {
          from: ['running'],
          to: 'blocked',
          extra: { setSql: 'assignee_runtime = NULL' },
        })
      : 0;
    if (changes === 0) {
      if (!readCardRow(db, tenantId, id)) {
        throw unknownCard(id);
      }
      return rollback(false);
    }
    const now = handleStamp(db);
    // Close the interrupted run here so completeCardRow's ended IS NULL scope only ever matches the
    // live run.
    closeLiveRun(db, { tenantId, cardId: id, outcome: 'blocked', now });
    insertCardComment(db, { tenantId, cardId: id, author: 'system', body: reason });
    return true;
  });
  return blocked ? readCardRow(db, tenantId, id) : null;
}

/** Requires the card be running; moves it to review, clearing its lease and heartbeat and
 * keeping its live run. When runId is given, returns null unless it is the card's live run.
 * Throws on an unknown card id; returns null for a card not running. */
export function reviewCardRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  runId?: number,
): Card | null {
  assertTenantId('reviewCardRow', tenantId);
  if (runId !== undefined) assertRunId(runId);
  const moved = withWriteScopeOr(db, 'review_card', (rollback) => {
    const allowed = runId === undefined || liveRunIs(db, tenantId, id, runId);
    const changes = allowed
      ? transitionCard(db, tenantId, id, { from: ['running'], to: 'review' })
      : 0;
    if (changes === 0) {
      if (!readCardRow(db, tenantId, id)) {
        throw unknownCard(id);
      }
      return rollback(false);
    }
    return true;
  });
  return moved ? readCardRow(db, tenantId, id) : null;
}

/** Closes the live run of a card in review: 'success' moves it to done and promotes children
 * whose parents are all done; 'failure'/'partial' shelves it. Throws on an unknown card id;
 * returns null for a card not in review, or when `runId` is given and is not the card's
 * live run. */
export function completeCardRow(
  db: DatabaseSyncLike,
  tenantId: string,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): { card: Card; promotedChildren: string[] } | null {
  assertTenantId('completeCardRow', tenantId);
  assertCardOutcome(outcome);
  if (runId !== undefined) assertRunId(runId);
  const promoted = withWriteScopeOr(db, 'complete_card', (rollback) => {
    const target: CardStatus = outcome === 'success' ? 'done' : 'shelved';
    const allowed = runId === undefined || liveRunIs(db, tenantId, id, runId);
    const changes = allowed
      ? transitionCard(db, tenantId, id, { from: ['review'], to: target })
      : 0;
    if (changes === 0) {
      if (!readCardRow(db, tenantId, id)) {
        throw unknownCard(id);
      }
      return rollback(null);
    }
    const now = handleStamp(db);
    closeLiveRun(db, { tenantId, cardId: id, outcome, now });

    // Not best-effort: promotion runs in this same transaction, so a card can never be `done` with
    // an un-evaluated child.
    return target === 'done' ? promoteUnblockedChildren(db, tenantId, id) : [];
  });
  return promoted === null
    ? null
    : { card: readCardRow(db, tenantId, id)!, promotedChildren: promoted };
}

/** Moves to ready each backlog child of `parentId` whose parents are all done, and returns their
 * ids. Call inside the write scope. */
function promoteUnblockedChildren(
  db: DatabaseSyncLike,
  tenantId: string,
  parentId: string,
): string[] {
  // The child's status and its open parents are result columns, not joins, so the rows keep the
  // order of a plain read of the parent's children.
  const children = cachedStatement(
    db,
    `
    SELECT d.child AS child,
      (SELECT c.status FROM cards c WHERE c.tenant_id = ? AND c.id = d.child) AS status,
      (SELECT COUNT(*) FROM card_deps p WHERE p.tenant_id = ? AND p.child = d.child
        AND NOT EXISTS (SELECT 1 FROM cards pc WHERE pc.tenant_id = ? AND pc.id = p.parent AND pc.status = 'done')) AS
        open_parents
    FROM card_deps d WHERE d.tenant_id = ? AND d.parent = ?
  `,
  ).all(tenantId, tenantId, tenantId, tenantId, parentId) as Array<{
    child: string;
    status: string | null;
    open_parents: number;
  }>;
  const unblocked = children
    .filter((r) => r.status === 'backlog' && r.open_parents === 0)
    .map((r) => r.child);
  for (const ids of chunked(unblocked)) {
    transitionCards(db, tenantId, ids, { from: ['backlog'], to: 'ready' });
  }
  return unblocked;
}

/** Returns to ready every running card of the tenant whose lease has expired or is missing:
 * clears its assignee, closes its live run as 'reclaimed' and leaves its handoffs alone, all in
 * one write transaction. Returns the reclaimed card ids in id order. */
export function reclaimExpiredCardRows(db: DatabaseSyncLike, tenantId: string): string[] {
  assertTenantId('reclaimExpiredCardRows', tenantId);
  return withWriteScope(db, 'reclaim_expired_cards', () => {
    // Read lease times under the write lock, so a heartbeat that committed while we waited wins.
    const now = handleStamp(db);
    const ids = (
      cachedStatement(
        db,
        `
      SELECT id FROM cards
      WHERE tenant_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)
      ORDER BY id
    `,
      ).all(tenantId, now) as Array<{ id: string }>
    ).map((r) => r.id);
    for (const id of ids) {
      transitionCard(db, tenantId, id, {
        from: ['running'],
        to: 'ready',
        extra: { setSql: 'assignee_runtime = NULL' },
      });
      closeLiveRun(db, { tenantId, cardId: id, outcome: 'reclaimed', now });
    }
    return ids;
  });
}
