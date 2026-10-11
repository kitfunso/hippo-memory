import { generateId } from '../core/memory.js';
import { withWriteScope, withWriteScopeOr, type DatabaseSyncLike } from '../db/index.js';
import { SessionHandoff, SessionHandoffRow, rowToSessionHandoff, isHandoffOutcome, HandoffOutcome } from '../core/handoff.js';
import { Card, CardStatus, CardRun, CardComment, CARD_LEASE_MS, assertCardTransition } from '../core/card.js';
import { assertTenantId } from './tenant.js';
import { onHandle, openStore } from './open.js';
import { chunked } from '../util/chunked.js';
import { HANDOFF_COLUMNS } from './handoffs.js';

interface CardRow {
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

const CARD_COLUMNS = 'id, title, status, assignee_runtime, repo, contract, budget, lease_until, heartbeat_at, created_at, updated_at, tenant_id, scope';

function rowToCard(row: CardRow): Card {
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

function loadCardRow(db: DatabaseSyncLike, tenantId: string, id: string): Card | null {
  // SAFETY: row's shape matches CARD_COLUMNS; status only ever holds a CardStatus value.
  const row = db.prepare(`SELECT ${CARD_COLUMNS} FROM cards WHERE id = ? AND tenant_id = ?`).get(id, tenantId) as CardRow | undefined;
  return row ? rowToCard(row) : null;
}

interface CardRunRow {
  id: number;
  card: string;
  runtime: string;
  session_id: string | null;
  started: string;
  ended: string | null;
  outcome: string | null;
}

function rowToCardRun(row: CardRunRow): CardRun {
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

interface CardCommentRow {
  id: number;
  card_id: string;
  author: string;
  body: string;
  created_at: string;
}

function rowToCardComment(row: CardCommentRow): CardComment {
  return { id: row.id, cardId: row.card_id, author: row.author, body: row.body, createdAt: row.created_at };
}

function insertCardComment(db: DatabaseSyncLike, tenantId: string, cardId: string, author: string, body: string): CardComment {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO card_comments (card_id, author, body, created_at, tenant_id)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM cards WHERE id = ? AND tenant_id = ?)
  `).run(cardId, author, body, now, tenantId, cardId, tenantId);
  if (Number(result.changes ?? 0) === 0) {
    throw new Error(`unknown card id: ${cardId}`);
  }
  const id = Number(result.lastInsertRowid ?? 0);
  return { id, cardId, author, body, createdAt: now };
}

function leaseUntilFrom(now: string): string {
  return new Date(Date.parse(now) + CARD_LEASE_MS).toISOString();
}

function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`Invalid run id: ${runId} (expected a positive integer)`);
  }
}

// A second run that has not ended means a corrupt store; throw rather than guess which run the caller means.
function isLiveRun(db: DatabaseSyncLike, tenantId: string, cardId: string, runId: number): boolean {
  // SAFETY: rows' shape matches the single `id` column named in the SELECT below.
  const rows = db.prepare(`SELECT id FROM card_runs WHERE tenant_id = ? AND card = ? AND ended IS NULL`).all(tenantId, cardId) as Array<{ id: number }>;
  if (rows.length > 1) {
    throw new Error(`card ${cardId} has ${rows.length} runs that have not ended`);
  }
  return rows[0]?.id === runId;
}

function closeLiveRun(db: DatabaseSyncLike, tenantId: string, cardId: string, outcome: string, now: string): void {
  db.prepare(`
    UPDATE card_runs SET ended = ?, outcome = ?, updated_at = ?
    WHERE card = ? AND tenant_id = ? AND ended IS NULL
  `).run(now, outcome, now, cardId, tenantId);
}

// The single status-mutating seam (rule 15): CARD_TRANSITIONS is the one
// runtime authority, so a hand-copied wrong `from` list fails fast here.
export interface TransitionCardOptions {
  readonly from: CardStatus[];
  readonly to: CardStatus;
  readonly extra?: { setSql?: string; whereSql?: string; params?: unknown[] };
}

function transitionCard(db: DatabaseSyncLike, tenantId: string, cardId: string, options: TransitionCardOptions): number {
  return transitionCards(db, tenantId, [cardId], options);
}

/** transitionCard for every card in `cardIds`, as one statement with one timestamp; returns how many moved. */
function transitionCards(db: DatabaseSyncLike, tenantId: string, cardIds: readonly string[], options: TransitionCardOptions): number {
  const { from, to, extra } = options;
  assertCardTransition(from, to);
  const now = new Date().toISOString();
  // Lease columns follow status: set on the move to running, cleared on every other move (rule 15).
  const lease = to === 'running' ? [leaseUntilFrom(now), now] : [null, null];
  const fromPlaceholders = from.map(() => '?').join(', ');
  const sql = `
    UPDATE cards SET status = ?, updated_at = ?, lease_until = ?, heartbeat_at = ?${extra?.setSql ? `, ${extra.setSql}` : ''}
    WHERE id IN (${cardIds.map(() => '?').join(', ')}) AND tenant_id = ? AND status IN (${fromPlaceholders})${extra?.whereSql ? ` AND ${extra.whereSql}` : ''}
  `;
  const params: unknown[] = [to, now, ...lease, ...(extra?.params ?? []), ...cardIds, tenantId, ...from];
  const result = db.prepare(sql).run(...params);
  return Number(result.changes ?? 0);
}

/** Creates a card; status is ready with no deps or once every dependsOn id is done, else backlog.
 * An unknown dependsOn id throws and commits nothing. A repeated dependsOn id is recorded once. */
export function createCard(
  hippoRoot: string,
  tenantId: string,
  input: { title: string; repo?: string; contract?: string; budget?: number; dependsOn?: string[] },
): Card {
  assertTenantId('createCard', tenantId);
  if (input.title.trim() === '') {
    throw new Error('title must not be empty');
  }
  if (input.budget !== undefined && !(Number.isSafeInteger(input.budget) && input.budget > 0)) {
    throw new Error(`Invalid budget: ${input.budget} (expected a positive integer)`);
  }
  return onHandle(hippoRoot, (db) => {
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    let id = '';

    withWriteScope(db, 'create_card', () => {
      // Probe runs inside the transaction (mirrors batchWriteAndDelete): a parent
      // completing between an outside-the-lock read and the INSERT would strand the child.
      const allParentsDone = everyParentDone(db, tenantId, dependsOn);

      id = generateId('card');
      const now = new Date().toISOString();
      const status: CardStatus = dependsOn.length === 0 || allParentsDone ? 'ready' : 'backlog';

      db.prepare(`
        INSERT INTO cards (id, title, status, repo, contract, budget, created_at, updated_at, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.title, status, input.repo ?? null, input.contract ?? null, input.budget ?? null, now, now, tenantId);
      const insertDep = db.prepare(`
        INSERT INTO card_deps (parent, child, tenant_id, created_at) VALUES (?, ?, ?, ?)
      `);
      for (const parentId of dependsOn) insertDep.run(parentId, id, tenantId, now);
    });
    return loadCardRow(db, tenantId, id)!;
  }, openStore);
}

/** Whether every dependsOn card is done, true for none; throws on an id that is no card of the tenant. Call inside the write scope. */
function everyParentDone(db: DatabaseSyncLike, tenantId: string, dependsOn: readonly string[]): boolean {
  if (dependsOn.length === 0) return true;
  const placeholders = dependsOn.map(() => '?').join(', ');
  // SAFETY: rows' shape matches the two columns named in the SELECT below.
  const rows = db.prepare(
    `SELECT id, status FROM cards WHERE tenant_id = ? AND id IN (${placeholders})`,
  ).all(tenantId, ...dependsOn) as Array<{ id: string; status: string }>;
  const found = new Map(rows.map((r) => [r.id, r.status]));
  // Pre-check before any write: a typo'd --depends-on can never commit a card row.
  for (const parentId of dependsOn) {
    if (!found.has(parentId)) {
      throw new Error(`unknown parent card id: ${parentId}`);
    }
  }
  return dependsOn.every((pid) => found.get(pid) === 'done');
}

/** Returns the card row for id, or null if it does not exist under this tenant. */
export function loadCard(hippoRoot: string, tenantId: string, id: string): Card | null {
  assertTenantId('loadCard', tenantId);
  return onHandle(hippoRoot, (db) => {
    return loadCardRow(db, tenantId, id);
  }, openStore);
}

/** Lists cards for this tenant, optionally filtered to one status, newest-updated first. */
export function listCards(hippoRoot: string, tenantId: string, opts: { status?: CardStatus } = {}): Card[] {
  assertTenantId('listCards', tenantId);
  return onHandle(hippoRoot, (db) => {
    const conditions = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    // SAFETY: rows' shape matches CARD_COLUMNS; status only ever holds a CardStatus value.
    const rows = db.prepare(`
      SELECT ${CARD_COLUMNS} FROM cards WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id DESC
    `).all(...params) as CardRow[];
    return rows.map(rowToCard);
  }, openStore);
}

/** Returns this card's parent and child ids from card_deps. */
export function loadCardDeps(hippoRoot: string, tenantId: string, id: string) {
  assertTenantId('loadCardDeps', tenantId);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: rows' shape matches the single `parent` column named in the SELECT below.
    const parents = (db.prepare(`SELECT parent FROM card_deps WHERE tenant_id = ? AND child = ?`).all(
      tenantId,
      id
    ) as Array<{ parent: string }>).map((r) => r.parent);
    // SAFETY: rows' shape matches the single `child` column named in the SELECT below.
    const children = (db.prepare(`SELECT child FROM card_deps WHERE tenant_id = ? AND parent = ?`).all(
      tenantId,
      id
    ) as Array<{ child: string }>).map((r) => r.child);
    return { parents, children };
  }, openStore);
}

/** Returns this card's run history, most recent first. */
export function loadCardRuns(hippoRoot: string, tenantId: string, id: string): CardRun[] {
  assertTenantId('loadCardRuns', tenantId);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: rows' shape matches CardRunRow.
    const rows = db.prepare(`
      SELECT id, card, runtime, session_id, started, ended, outcome
      FROM card_runs WHERE tenant_id = ? AND card = ? ORDER BY started DESC, id DESC
    `).all(tenantId, id) as CardRunRow[];
    return rows.map(rowToCardRun);
  }, openStore);
}

/** Returns this card's comments, most recent first. */
export function loadCardComments(hippoRoot: string, tenantId: string, id: string): CardComment[] {
  assertTenantId('loadCardComments', tenantId);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: rows' shape matches CardCommentRow.
    const rows = db.prepare(`
      SELECT id, card_id, author, body, created_at
      FROM card_comments WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC, id DESC
    `).all(tenantId, id) as CardCommentRow[];
    return rows.map(rowToCardComment);
  }, openStore);
}

/** Read side of the card <-> handoff round trip: the newest handoff filed against this card. */
export function loadLatestHandoffForCard(hippoRoot: string, tenantId: string, cardId: string): SessionHandoff | null {
  assertTenantId('loadLatestHandoffForCard', tenantId);
  return onHandle(hippoRoot, (db) => {
    // SAFETY: row's shape matches HANDOFF_COLUMNS.
    const row = db.prepare(`
      SELECT ${HANDOFF_COLUMNS} FROM session_handoffs
      WHERE tenant_id = ? AND card_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(tenantId, cardId) as SessionHandoffRow | undefined;
    return row ? rowToSessionHandoff(row) : null;
  }, openStore);
}

/** Atomic claim: WHERE status IN (ready, blocked) AND assignee_runtime IS NULL decides the race. Throws on an unknown card id;
 * returns null for a card not ready/blocked or already claimed. Sets a CARD_LEASE_MS lease and returns the new run's id as runId. */
export function claimCard(hippoRoot: string, tenantId: string, id: string, runtime: string, sessionId?: string): (Card & { runId: number }) | null {
  assertTenantId('claimCard', tenantId);
  if (runtime.trim() === '') {
    throw new Error('runtime must not be empty');
  }
  return onHandle(hippoRoot, (db) => {
    const runId = withWriteScopeOr(db, 'claim_card', (rollback) => {
      const changes = transitionCard(db, tenantId, id, {
        from: ['ready', 'blocked'],
        to: 'running',
        extra: { setSql: 'assignee_runtime = ?', whereSql: 'assignee_runtime IS NULL', params: [runtime] },
      });
      if (changes === 0) {
        if (!loadCardRow(db, tenantId, id)) {
          throw new Error(`unknown card id: ${id}`);
        }
        return rollback(null);
      }
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO card_runs (card, runtime, session_id, started, created_at, updated_at, tenant_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, runtime, sessionId ?? null, now, now, now, tenantId);
      return Number(insert.lastInsertRowid ?? 0);
    });
    return runId === null ? null : { ...loadCardRow(db, tenantId, id)!, runId };
  }, openStore);
}

/** Moves a running card's lease to CARD_LEASE_MS from now and records the heartbeat; updated_at is left alone. Throws on an
 * unknown card id or a run id that is not a positive integer; returns null unless the card is running and runId is its live run. */
export function heartbeatCard(hippoRoot: string, tenantId: string, id: string, runId: number): Card | null {
  assertTenantId('heartbeatCard', tenantId);
  assertRunId(runId);
  return onHandle(hippoRoot, (db) => {
    const beat = withWriteScopeOr(db, 'heartbeat_card', (rollback) => {
      const card = loadCardRow(db, tenantId, id);
      if (!card) {
        throw new Error(`unknown card id: ${id}`);
      }
      if (card.status !== 'running' || !isLiveRun(db, tenantId, id, runId)) {
        return rollback(false);
      }
      const now = new Date().toISOString();
      db.prepare(`UPDATE cards SET lease_until = ?, heartbeat_at = ? WHERE id = ? AND tenant_id = ?`)
        .run(leaseUntilFrom(now), now, id, tenantId);
      return true;
    });
    return beat ? loadCardRow(db, tenantId, id) : null;
  }, openStore);
}

/** Requires the card be running; closes the live run as blocked and files reason as a comment. Throws on an unknown
 * card id; returns null for a card not running. When runId is given, returns null unless it is the card's live run. */
export function blockCard(hippoRoot: string, tenantId: string, id: string, reason: string, runId?: number): Card | null {
  assertTenantId('blockCard', tenantId);
  if (reason.trim() === '') {
    throw new Error('reason must not be empty');
  }
  if (runId !== undefined) assertRunId(runId);
  return onHandle(hippoRoot, (db) => {
    const blocked = withWriteScopeOr(db, 'block_card', (rollback) => {
      const allowed = runId === undefined || isLiveRun(db, tenantId, id, runId);
      const changes = allowed ? transitionCard(db, tenantId, id, { from: ['running'], to: 'blocked', extra: { setSql: 'assignee_runtime = NULL' } }) : 0;
      if (changes === 0) {
        if (!loadCardRow(db, tenantId, id)) {
          throw new Error(`unknown card id: ${id}`);
        }
        return rollback(false);
      }
      const now = new Date().toISOString();
      // Close the interrupted run here so completeCard's ended IS NULL scope only ever matches the live run.
      closeLiveRun(db, tenantId, id, 'blocked', now);
      insertCardComment(db, tenantId, id, 'system', reason);
      return true;
    });
    return blocked ? loadCardRow(db, tenantId, id) : null;
  }, openStore);
}

/** Requires the card be running; moves it to review, clearing its lease and heartbeat and keeping its live run. When runId is
 * given, returns null unless it is the card's live run. Throws on an unknown card id; returns null for a card not running. */
export function reviewCard(hippoRoot: string, tenantId: string, id: string, runId?: number): Card | null {
  assertTenantId('reviewCard', tenantId);
  if (runId !== undefined) assertRunId(runId);
  return onHandle(hippoRoot, (db) => {
    const moved = withWriteScopeOr(db, 'review_card', (rollback) => {
      const allowed = runId === undefined || isLiveRun(db, tenantId, id, runId);
      const changes = allowed ? transitionCard(db, tenantId, id, { from: ['running'], to: 'review' }) : 0;
      if (changes === 0) {
        if (!loadCardRow(db, tenantId, id)) {
          throw new Error(`unknown card id: ${id}`);
        }
        return rollback(false);
      }
      return true;
    });
    return moved ? loadCardRow(db, tenantId, id) : null;
  }, openStore);
}

/** Closes the live run of a card in review: 'success' moves it to done and promotes children whose parents are all done; 'failure'/'partial' shelves it.
 * Throws on an unknown card id; returns null for a card not in review, or when `runId` is given and is not the card's live run. */
export function completeCard(
  hippoRoot: string,
  tenantId: string,
  id: string,
  outcome: HandoffOutcome,
  runId?: number,
): { card: Card; promotedChildren: string[] } | null {
  assertTenantId('completeCard', tenantId);
  if (!isHandoffOutcome(outcome)) {
    throw new Error(`invalid card outcome: ${String(outcome)}`);
  }
  if (runId !== undefined) assertRunId(runId);
  return onHandle(hippoRoot, (db) => {
    const promoted = withWriteScopeOr(db, 'complete_card', (rollback) => {
      const target: CardStatus = outcome === 'success' ? 'done' : 'shelved';
      const allowed = runId === undefined || isLiveRun(db, tenantId, id, runId);
      const changes = allowed ? transitionCard(db, tenantId, id, { from: ['review'], to: target }) : 0;
      if (changes === 0) {
        if (!loadCardRow(db, tenantId, id)) {
          throw new Error(`unknown card id: ${id}`);
        }
        return rollback(null);
      }
      const now = new Date().toISOString();
      closeLiveRun(db, tenantId, id, outcome, now);

      // Not best-effort (rule 12): promotion runs in this same transaction, so a
      // card can never be `done` with an un-evaluated child.
      return target === 'done' ? promoteUnblockedChildren(db, tenantId, id) : [];
    });
    return promoted === null ? null : { card: loadCardRow(db, tenantId, id)!, promotedChildren: promoted };
  }, openStore);
}

/** Moves to ready each backlog child of `parentId` whose parents are all done, and returns their ids. Call inside the write scope. */
function promoteUnblockedChildren(db: DatabaseSyncLike, tenantId: string, parentId: string): string[] {
  // The child's status and its open parents are result columns, not joins, so the rows keep the order of a plain read of the parent's children.
  // SAFETY: rows' shape matches the three columns named in the SELECT below.
  const children = db.prepare(`
    SELECT d.child AS child,
      (SELECT c.status FROM cards c WHERE c.tenant_id = ? AND c.id = d.child) AS status,
      (SELECT COUNT(*) FROM card_deps p WHERE p.tenant_id = ? AND p.child = d.child
        AND NOT EXISTS (SELECT 1 FROM cards pc WHERE pc.tenant_id = ? AND pc.id = p.parent AND pc.status = 'done')) AS open_parents
    FROM card_deps d WHERE d.tenant_id = ? AND d.parent = ?
  `).all(tenantId, tenantId, tenantId, tenantId, parentId) as Array<{ child: string; status: string | null; open_parents: number }>;
  const unblocked = children.filter((r) => r.status === 'backlog' && r.open_parents === 0).map((r) => r.child);
  for (const ids of chunked(unblocked)) transitionCards(db, tenantId, ids, { from: ['backlog'], to: 'ready' });
  return unblocked;
}

/** Returns to ready every running card of the tenant whose lease has expired or is missing: clears its assignee, closes its live
 * run as 'reclaimed' and leaves its handoffs alone, all in one write transaction. Returns the reclaimed card ids in id order. */
export function reclaimExpiredCards(hippoRoot: string, tenantId: string): string[] {
  assertTenantId('reclaimExpiredCards', tenantId);
  return onHandle(hippoRoot, (db) => {
    return withWriteScope(db, 'reclaim_expired_cards', () => {
      // Read lease times under the write lock, so a heartbeat that committed while we waited wins.
      const now = new Date().toISOString();
      // SAFETY: rows' shape matches the single `id` column named in the SELECT below.
      const ids = (db.prepare(`
        SELECT id FROM cards
        WHERE tenant_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until < ?)
        ORDER BY id
      `).all(tenantId, now) as Array<{ id: string }>).map((r) => r.id);
      for (const id of ids) {
        transitionCard(db, tenantId, id, { from: ['running'], to: 'ready', extra: { setSql: 'assignee_runtime = NULL' } });
        closeLiveRun(db, tenantId, id, 'reclaimed', now);
      }
      return ids;
    });
  }, openStore);
}

/** Appends a comment to cardId in any card status; throws if cardId is not a card of this tenant. */
export function addCardComment(hippoRoot: string, tenantId: string, cardId: string, author: string, body: string): CardComment {
  assertTenantId('addCardComment', tenantId);
  if (body.trim() === '') {
    throw new Error('body must not be empty');
  }
  return onHandle(hippoRoot, (db) => {
    return insertCardComment(db, tenantId, cardId, author, body);
  }, openStore);
}
