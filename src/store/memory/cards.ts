// The in-memory Cards group: the agent work board, under the shared card checks, transitions and lease.
import { generateId } from '../../base/memory/memory.js';
import { assertCardTransition, type Card, type CardStatus } from '../../base/records/card.js';
import type { CardComment, CardRun } from '../../base/records/card.js';
import { rowToSessionHandoff, type HandoffOutcome } from '../../base/session/handoff.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { CardDetail, CardCreate, CardListQuery, CardPage, Cards } from '../port/cards.js';
import { keysetPage } from '../../base/util/keyset.js';
import {
  assertCardCreate,
  assertCardOutcome,
  assertFilled,
  assertRunId,
  isLiveRun,
  leaseUntilFrom,
  unknownCard,
  unknownParentCard,
} from '../rules/cards.js';
import { byBytes, isBelow, newestFirst, type DescendingKeyset } from '../rules/order.js';
import { nextId, ownedRow } from './rows.js';
import type { MemoryTables } from './tables.js';

const cardOf = (t: MemoryTables, tenantId: string, id: string): Card | null => ownedRow(t.cards, tenantId, id) ?? null;

function known(t: MemoryTables, tenantId: string, id: string): Card {
  const card = cardOf(t, tenantId, id);
  if (!card) throw unknownCard(id);
  return card;
}

function liveRunIs(t: MemoryTables, tenantId: string, cardId: string, runId: number): boolean {
  const live = t.cardRuns.filter((r) => r.tenantId === tenantId && r.row.card === cardId && r.row.ended === null);
  return isLiveRun(
    cardId,
    live.map((r) => r.row.id),
    runId,
  );
}

function closeLiveRun(t: MemoryTables, tenantId: string, cardId: string, outcome: string, now: string): void {
  for (const run of t.cardRuns) {
    if (run.tenantId === tenantId && run.row.card === cardId && run.row.ended === null) {
      run.row = { ...run.row, ended: now, outcome };
    }
  }
}

/** The one status write: the move is checked first, and the lease is set on the move to running and cleared on any
 * other. False when the card is not in a `from` status. */
function transition(
  t: MemoryTables,
  card: Card,
  from: readonly CardStatus[],
  to: CardStatus,
  assignee?: string | null,
) {
  assertCardTransition(from, to);
  if (!from.includes(card.status)) return false;
  const now = new Date().toISOString();
  const lease =
    to === 'running' ? { leaseUntil: leaseUntilFrom(now), heartbeatAt: now } : { leaseUntil: null, heartbeatAt: null };
  const moved = { ...card, status: to, updatedAt: now, ...lease };
  t.cards.set(card.id, assignee === undefined ? moved : { ...moved, assigneeRuntime: assignee });
  return true;
}

function createIn(t: MemoryTables, tenantId: string, input: CardCreate): Card {
  assertTenantId('createCard', tenantId);
  assertCardCreate(input);
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  // Checked before any write, so a mistyped parent id never leaves a card behind.
  for (const parentId of dependsOn) {
    if (!cardOf(t, tenantId, parentId)) throw unknownParentCard(parentId);
  }
  const allDone = dependsOn.every((pid) => cardOf(t, tenantId, pid)?.status === 'done');
  const now = new Date().toISOString();
  const card: Card = {
    id: generateId('card'),
    title: input.title,
    status: allDone ? 'ready' : 'backlog',
    assigneeRuntime: null,
    repo: input.repo ?? null,
    contract: input.contract ?? null,
    budget: input.budget ?? null,
    leaseUntil: null,
    heartbeatAt: null,
    createdAt: now,
    updatedAt: now,
    tenantId,
    scope: null,
  };
  t.cards.set(card.id, card);
  for (const parent of dependsOn) t.cardDeps.push({ tenantId, parent, child: card.id });
  return { ...card };
}

function runsOf(t: MemoryTables, tenantId: string, id: string): CardRun[] {
  const runs = t.cardRuns.filter((r) => r.tenantId === tenantId && r.row.card === id).map((r) => ({ ...r.row }));
  return runs.sort(newestFirst<CardRun>({ key: (r) => r.started, intId: (r) => r.id }));
}

// card_deps has no rowid, so each read comes back in its index's order: by the other id's bytes.
function depsOf(t: MemoryTables, tenantId: string, id: string): CardDetail['deps'] {
  const mine = t.cardDeps.filter((d) => d.tenantId === tenantId);
  const parents = mine.filter((d) => d.child === id).map((d) => d.parent);
  const children = mine.filter((d) => d.parent === id).map((d) => d.child);
  return { parents: parents.sort(byBytes), children: children.sort(byBytes) };
}

function detailIn(t: MemoryTables, tenantId: string, id: string): CardDetail | null {
  assertTenantId('loadCardDetail', tenantId);
  const card = cardOf(t, tenantId, id);
  if (!card) return null;
  const comments = t.cardComments
    .filter((c) => c.tenantId === tenantId && c.row.cardId === id)
    .map((c) => ({ ...c.row }))
    .sort(newestFirst({ key: (c) => c.createdAt, intId: (c) => c.id }));
  const handoffs = t.handoffs
    .filter((h) => h.tenantId === tenantId && h.row.card_id === id)
    .sort(newestFirst({ key: (h) => h.row.created_at, intId: (h) => h.row.id }));
  const handoff = handoffs[0] ? rowToSessionHandoff(handoffs[0].row) : null;
  return { card: { ...card }, deps: depsOf(t, tenantId, id), runs: runsOf(t, tenantId, id), comments, handoff };
}

function claimIn(t: MemoryTables, tenantId: string, id: string, runtime: string, sessionId?: string) {
  assertTenantId('claimCard', tenantId);
  assertFilled('runtime', runtime);
  assertCardTransition(['ready', 'blocked'], 'running');
  const card = known(t, tenantId, id);
  if (card.assigneeRuntime !== null || !transition(t, card, ['ready', 'blocked'], 'running', runtime)) return null;
  const now = new Date().toISOString();
  const runId = nextId(t, 'card_runs');
  const row = { id: runId, card: id, runtime, sessionId: sessionId ?? null, started: now, ended: null, outcome: null };
  t.cardRuns.push({ tenantId, row });
  return { ...known(t, tenantId, id), runId };
}

function heartbeatIn(t: MemoryTables, tenantId: string, id: string, runId: number): Card | null {
  assertTenantId('heartbeatCard', tenantId);
  assertRunId(runId);
  const card = known(t, tenantId, id);
  if (card.status !== 'running' || !liveRunIs(t, tenantId, id, runId)) return null;
  const now = new Date().toISOString();
  t.cards.set(id, { ...card, leaseUntil: leaseUntilFrom(now), heartbeatAt: now });
  return { ...known(t, tenantId, id) };
}

function commentIn(t: MemoryTables, tenantId: string, cardId: string, author: string, body: string): CardComment {
  known(t, tenantId, cardId);
  const row = { id: nextId(t, 'card_comments'), cardId, author, body, createdAt: new Date().toISOString() };
  t.cardComments.push({ tenantId, row });
  return { ...row };
}

/** A move out of running, gated on the live run when `runId` is given; null when the card does not move. */
function leaveRunning(t: MemoryTables, tenantId: string, id: string, to: CardStatus, runId?: number): Card | null {
  if (runId !== undefined) assertRunId(runId);
  const allowed = runId === undefined || liveRunIs(t, tenantId, id, runId);
  const card = known(t, tenantId, id);
  const assignee = to === 'blocked' ? null : undefined;
  return allowed && transition(t, card, ['running'], to, assignee) ? known(t, tenantId, id) : null;
}

function blockIn(t: MemoryTables, tenantId: string, id: string, reason: string, runId?: number): Card | null {
  assertTenantId('blockCard', tenantId);
  assertFilled('reason', reason);
  assertCardTransition(['running'], 'blocked');
  if (!leaveRunning(t, tenantId, id, 'blocked', runId)) return null;
  // The interrupted run closes here, so complete's live-run match only ever finds the live one.
  closeLiveRun(t, tenantId, id, 'blocked', new Date().toISOString());
  commentIn(t, tenantId, id, 'system', reason);
  return { ...known(t, tenantId, id) };
}

/** Moves to ready each backlog child of `parentId` whose parents are all done. */
function promoteChildren(t: MemoryTables, tenantId: string, parentId: string): string[] {
  const { children } = depsOf(t, tenantId, parentId);
  const unblocked = children.filter(
    (child) =>
      cardOf(t, tenantId, child)?.status === 'backlog' &&
      depsOf(t, tenantId, child).parents.every((p) => cardOf(t, tenantId, p)?.status === 'done'),
  );
  for (const child of unblocked) transition(t, known(t, tenantId, child), ['backlog'], 'ready');
  return unblocked;
}

function completeIn(t: MemoryTables, tenantId: string, id: string, outcome: HandoffOutcome, runId?: number) {
  assertTenantId('completeCard', tenantId);
  assertCardOutcome(outcome);
  if (runId !== undefined) assertRunId(runId);
  const target: CardStatus = outcome === 'success' ? 'done' : 'shelved';
  assertCardTransition(['review'], target);
  const allowed = runId === undefined || liveRunIs(t, tenantId, id, runId);
  const card = known(t, tenantId, id);
  if (!allowed || !transition(t, card, ['review'], target)) return null;
  closeLiveRun(t, tenantId, id, outcome, new Date().toISOString());
  const promotedChildren = target === 'done' ? promoteChildren(t, tenantId, id) : [];
  return { card: { ...known(t, tenantId, id) }, promotedChildren };
}

function reclaimIn(t: MemoryTables, tenantId: string): string[] {
  assertTenantId('reclaimExpiredCards', tenantId);
  const now = new Date().toISOString();
  const ids = [...t.cards.values()]
    .filter(
      (c) =>
        c.tenantId === tenantId && c.status === 'running' && (c.leaseUntil === null || byBytes(c.leaseUntil, now) < 0),
    )
    .map((c) => c.id)
    .sort(byBytes);
  for (const id of ids) {
    transition(t, known(t, tenantId, id), ['running'], 'ready', null);
    closeLiveRun(t, tenantId, id, 'reclaimed', now);
  }
  return ids;
}

const WALK: DescendingKeyset<Card> = { key: (c) => c.updatedAt, textId: (c) => c.id };

function listIn(t: MemoryTables, tenantId: string, { status, limit, after }: CardListQuery): CardPage {
  assertTenantId('listCards', tenantId);
  const cards = [...t.cards.values()].filter(
    (c) => c.tenantId === tenantId && (!status || c.status === status) && (!after || isBelow(WALK, c, after)),
  );
  const sorted = cards.sort(newestFirst(WALK)).slice(0, limit + 1);
  const page = keysetPage(sorted, limit, (card) => ({ key: card.updatedAt, id: card.id }));
  return { cards: page.rows.map((c) => ({ ...c })), next: page.next };
}

export function memoryCards(t: MemoryTables): Cards {
  return {
    create: async (tenantId, input) => createIn(t, tenantId, input),
    async load(tenantId, id) {
      assertTenantId('loadCard', tenantId);
      const card = cardOf(t, tenantId, id);
      return card ? { ...card } : null;
    },
    detail: async (tenantId, id) => detailIn(t, tenantId, id),
    list: async (tenantId, query) => listIn(t, tenantId, query),
    runs: async (tenantId, id) => runsOf(t, tenantId, id),
    claim: async (tenantId, id, runtime, sessionId) => claimIn(t, tenantId, id, runtime, sessionId),
    heartbeat: async (tenantId, id, runId) => heartbeatIn(t, tenantId, id, runId),
    block: async (tenantId, id, reason, runId) => blockIn(t, tenantId, id, reason, runId),
    async review(tenantId, id, runId) {
      assertTenantId('reviewCard', tenantId);
      assertCardTransition(['running'], 'review');
      const card = leaveRunning(t, tenantId, id, 'review', runId);
      return card ? { ...card } : null;
    },
    complete: async (tenantId, id, outcome, runId) => completeIn(t, tenantId, id, outcome, runId),
    reclaimExpired: async (tenantId) => reclaimIn(t, tenantId),
    async comment(tenantId, cardId, author, body) {
      assertTenantId('addCardComment', tenantId);
      assertFilled('body', body);
      return commentIn(t, tenantId, cardId, author, body);
    },
  };
}
