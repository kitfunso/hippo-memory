// The in-memory Cards group: the agent work board, with hippo.db's transition, lease and promotion rules.
import { generateId } from '../../base/memory/memory.js';
import { assertCardTransition, CARD_LEASE_MS, type Card, type CardStatus } from '../../base/records/card.js';
import type { CardComment, CardRun } from '../../base/records/card.js';
import { isHandoffOutcome, rowToSessionHandoff, type HandoffOutcome } from '../../base/session/handoff.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { CardDetail } from '../port/cards.js';
import type { CardCreate, Cards } from '../port-groups.js';
import { byBytes, nextId } from './rows.js';
import type { MemoryTables } from './tables.js';

const leaseUntilFrom = (now: string): string => new Date(Date.parse(now) + CARD_LEASE_MS).toISOString();

function assertRunId(runId: number): void {
  if (!Number.isSafeInteger(runId) || runId <= 0) {
    throw new Error(`Invalid run id: ${runId} (expected a positive integer)`);
  }
}

function cardOf(t: MemoryTables, tenantId: string, id: string): Card | null {
  const card = t.cards.get(id);
  return card && card.tenantId === tenantId ? card : null;
}

function known(t: MemoryTables, tenantId: string, id: string): Card {
  const card = cardOf(t, tenantId, id);
  if (!card) throw new Error(`unknown card id: ${id}`);
  return card;
}

// A second run that has not ended means a corrupt store; throw rather than guess which run the caller means.
function isLiveRun(t: MemoryTables, tenantId: string, cardId: string, runId: number): boolean {
  const live = t.cardRuns.filter((r) => r.tenantId === tenantId && r.row.card === cardId && r.row.ended === null);
  if (live.length > 1) throw new Error(`card ${cardId} has ${live.length} runs that have not ended`);
  return live[0]?.row.id === runId;
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
  if (input.title.trim() === '') throw new Error('title must not be empty');
  if (input.budget !== undefined && !(Number.isSafeInteger(input.budget) && input.budget > 0)) {
    throw new Error(`Invalid budget: ${input.budget} (expected a positive integer)`);
  }
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  // Checked before any write, so a mistyped parent id never leaves a card behind.
  for (const parentId of dependsOn) {
    if (!cardOf(t, tenantId, parentId)) throw new Error(`unknown parent card id: ${parentId}`);
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
  return runs.sort((a, b) => byBytes(b.started, a.started) || b.id - a.id);
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
    .sort((a, b) => byBytes(b.createdAt, a.createdAt) || b.id - a.id);
  const handoffs = t.handoffs
    .filter((h) => h.tenantId === tenantId && h.row.card_id === id)
    .sort((a, b) => byBytes(b.row.created_at, a.row.created_at) || b.row.id - a.row.id);
  const handoff = handoffs[0] ? rowToSessionHandoff(handoffs[0].row) : null;
  return { card: { ...card }, deps: depsOf(t, tenantId, id), runs: runsOf(t, tenantId, id), comments, handoff };
}

function claimIn(t: MemoryTables, tenantId: string, id: string, runtime: string, sessionId?: string) {
  assertTenantId('claimCard', tenantId);
  if (runtime.trim() === '') throw new Error('runtime must not be empty');
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
  if (card.status !== 'running' || !isLiveRun(t, tenantId, id, runId)) return null;
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
  const allowed = runId === undefined || isLiveRun(t, tenantId, id, runId);
  const card = known(t, tenantId, id);
  const assignee = to === 'blocked' ? null : undefined;
  return allowed && transition(t, card, ['running'], to, assignee) ? known(t, tenantId, id) : null;
}

function blockIn(t: MemoryTables, tenantId: string, id: string, reason: string, runId?: number): Card | null {
  assertTenantId('blockCard', tenantId);
  if (reason.trim() === '') throw new Error('reason must not be empty');
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
  if (!isHandoffOutcome(outcome)) throw new Error(`invalid card outcome: ${String(outcome)}`);
  if (runId !== undefined) assertRunId(runId);
  const target: CardStatus = outcome === 'success' ? 'done' : 'shelved';
  assertCardTransition(['review'], target);
  const allowed = runId === undefined || isLiveRun(t, tenantId, id, runId);
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

function listIn(t: MemoryTables, tenantId: string, status?: CardStatus): Card[] {
  assertTenantId('listCards', tenantId);
  const cards = [...t.cards.values()].filter((c) => c.tenantId === tenantId && (!status || c.status === status));
  return cards.sort((a, b) => byBytes(b.updatedAt, a.updatedAt) || byBytes(b.id, a.id)).map((c) => ({ ...c }));
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
    list: async (tenantId, { status }) => listIn(t, tenantId, status),
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
      if (body.trim() === '') throw new Error('body must not be empty');
      return commentIn(t, tenantId, cardId, author, body);
    },
  };
}
