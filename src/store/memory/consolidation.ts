// The in-memory Consolidation group: sleep's reads and writes over plain tables. It keeps no full-text index to drift
// and no graph extraction queue, so `begin` finds no drift and no tenant has graph work pending.
import { DAG_LEVEL, Layer, type MemoryEntry } from '../../base/memory/memory.js';
import { planHalfLifeMoves, type HalfLifeRows, type ObjectLink } from '../../base/memory/half-life-plan.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { keysetPage } from '../../base/util/keyset.js';
import { CONSOLIDATION_RUNS_KEPT } from '../../db/tables.js';
import type {
  Consolidation,
  SleepBegin,
  SleepStart,
  SummarySettle,
  SummarySettled,
} from '../../base/ports/store/consolidation.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { refusalAudit } from '../rules/audit-rows.js';
import { bareText } from '../rules/copies.js';
import {
  HALF_LIFE_BASE_META_KEY,
  TYPED_HALF_LIFE_META_KEY,
  halfLifeAuditRows,
  recordedHalfLifeBase,
} from '../rules/half-life.js';
import { byBytes, oldestFirst } from '../rules/order.js';
import { replaceConflictsIn } from './conflict-refresh.js';
import { appendAudit, tenantKey } from './rows.js';
import { commitIn } from './sleep-commit.js';
import { stage } from './staged.js';
import type { MemoryTables } from './tables.js';
import { storedParticle } from './vector-writes.js';

/** Each memory a typed object names: 'retired' when one such object is superseded or closed, else 'live'. */
function objectLinks(t: MemoryTables): Map<string, ObjectLink> {
  const links = new Map<string, ObjectLink>();
  for (const row of Object.values(t.objects).flatMap((table) => [...table.values()])) {
    if (row.memoryId === null) continue;
    const retired = row.status === 'superseded' || row.status === 'closed';
    if (retired || !links.has(row.memoryId)) links.set(row.memoryId, retired ? 'retired' : 'live');
  }
  return links;
}

function halfLifeRows(t: MemoryTables, from: number, typedPending: boolean): HalfLifeRows {
  const links = typedPending ? objectLinks(t) : new Map<string, ObjectLink>();
  const audits = typedPending ? t.audit.filter((e) => e.op === 'conflict_resolve') : [];
  const resolved = typedPending ? t.conflicts.filter((c) => c.status === 'resolved') : [];
  return {
    from,
    typedPending,
    conflictAudits: audits.map((e) => ({
      conflictId: Number(e.metadata.conflictId),
      loserId: String(e.metadata.loserId),
    })),
    resolvedConflicts: resolved.map((c) => ({ id: c.id, memory_a_id: c.memoryAId, memory_b_id: c.memoryBId })),
    rows: [...t.entries.values()].sort(oldestFirst).map((entry) => ({ entry, object: links.get(entry.id) ?? null })),
  };
}

/** The move, its audit rows and the new base, planned and written in one staged write. */
function moveHalfLivesIn(
  t: MemoryTables,
  to: number,
  { dryRun, actor }: SleepBegin,
): Pick<SleepStart, 'from' | 'outcome'> {
  const from = recordedHalfLifeBase(t.meta.get(HALF_LIFE_BASE_META_KEY));
  const typedPending = (t.meta.get(TYPED_HALF_LIFE_META_KEY) ?? '') === '';
  if (!(Number.isFinite(to) && to > 0) || (from === to && !typedPending)) return { from, outcome: null };
  const { moves, outcome } = planHalfLifeMoves(halfLifeRows(t, from, typedPending), to);
  if (dryRun) return { from, outcome };
  stage(t, actor, (tx) => {
    for (const move of moves) {
      for (const e of move.entries) tx.rows.set(e.id, { ...tx.rows.get(e.id)!, halfLifeDays: e.halfLifeDays });
      tx.audit.push(...halfLifeAuditRows(move, actor));
    }
  });
  t.meta.set(HALF_LIFE_BASE_META_KEY, String(to));
  t.meta.set(TYPED_HALF_LIFE_META_KEY, '1');
  return { from, outcome };
}

function sleepHistory(t: MemoryTables): Pick<SleepStart, 'sleepCount' | 'recentRuns'> {
  const recentRuns = t.sleepRuns
    .slice(-20)
    .reverse()
    .map((run) => run.timestamp);
  return { sleepCount: Number(t.meta.get('sleep_count') ?? '0') || 0, recentRuns };
}

/** The tenant's sessions completed since `sinceMs` that no trace of the tenant names, in event order. */
function untracedSessions(t: MemoryTables, { tenantId, sinceMs }: NonNullable<SleepBegin['traces']>): string[] {
  const since = new Date(sinceMs).toISOString();
  const traces = [...t.entries.values()].filter((e) => e.tenantId === tenantId && e.layer === Layer.Trace);
  const traced = new Set(traces.map((e) => e.sourceSessionId));
  const done = t.events.filter(
    (e) => e.tenantId === tenantId && e.row.eventType === 'session_complete' && byBytes(e.row.createdAt, since) >= 0,
  );
  return [...new Set(done.map((e) => e.row.sessionId))].filter((id) => !traced.has(id));
}

function beginIn(t: MemoryTables, to: number, opts: SleepBegin): SleepStart {
  const start = moveHalfLivesIn(t, to, opts);
  return { ...start, fts: null, ...sleepHistory(t), sessions: opts.traces ? untracedSessions(t, opts.traces) : [] };
}

/** The rows after `page.after` in (created, id) order, one past the limit read to say whether more follow. */
function pageAfter<T>(
  rows: readonly MemoryEntry[],
  page: { limit: number; after?: EntryCursor },
  as: (e: MemoryEntry) => T,
) {
  const { after } = page;
  const later = (e: MemoryEntry): boolean =>
    after === undefined ||
    byBytes(e.created, after.created) > 0 ||
    (e.created === after.created && byBytes(e.id, after.id) > 0);
  const kept = keysetPage(rows.filter(later).slice(0, page.limit + 1), page.limit, (e) => ({
    created: e.created,
    id: e.id,
  }));
  return { items: kept.rows.map(as), next: kept.next };
}

const live = (e: MemoryEntry): boolean => e.kind !== 'archived' && !e.supersededBy;

/** latest_at DESC NULLS LAST, then id, as hippo.db orders the dirty queue. */
function newestChangeFirst(a: MemoryEntry, b: MemoryEntry): number {
  if ((a.latestAt ?? null) === null || (b.latestAt ?? null) === null) {
    if ((a.latestAt ?? null) !== (b.latestAt ?? null)) return (a.latestAt ?? null) === null ? 1 : -1;
  } else if (a.latestAt !== b.latestAt) return byBytes(b.latestAt!, a.latestAt!);
  return byBytes(a.id, b.id);
}

function dirtySummariesIn(t: MemoryTables, limit: number) {
  const dirty = [...t.entries.values()].filter((e) => e.summaryDirty === true && e.kind !== 'archived');
  const queue = dirty.sort(newestChangeFirst).slice(0, limit);
  const childrenOf = (s: MemoryEntry): MemoryEntry[] =>
    [...t.entries.values()]
      .filter((e) => e.dagParentId === s.id && e.tenantId === s.tenantId && live(e))
      .sort(oldestFirst);
  const summaries = queue.map((summary) => ({ summary, children: childrenOf(summary) }));
  return { summaries: structuredClone(summaries), more: dirty.length > limit };
}

function settleIn(t: MemoryTables, settle: SummarySettle): SummarySettled {
  const row = t.entries.get(settle.id);
  const summaryLevel = row?.dagLevel === DAG_LEVEL.topic || row?.dagLevel === DAG_LEVEL.entity;
  if (
    !row ||
    row.tenantId !== settle.tenantId ||
    !summaryLevel ||
    row.summaryDirty !== true ||
    row.kind === 'archived'
  ) {
    return { changed: false, refused: false };
  }
  const { fields } = settle;
  const content = fields?.content;
  const tombstone = content && t.rejected.get(tenantKey(settle.tenantId, rejectionDigest(content.text)));
  const rebuilt =
    content && !tombstone
      ? { content: content.text, lastRebuiltAt: content.rebuiltAt, rebuildCount: (row.rebuildCount ?? 0) + 1 }
      : {};
  const counts = fields
    ? { descendantCount: fields.descendantCount, earliestAt: fields.earliestAt, latestAt: fields.latestAt }
    : {};
  stage(t, settle.actor, (tx) => {
    tx.rows.set(row.id, { ...row, ...counts, ...rebuilt, summaryDirty: false });
    if (tombstone) tx.audit.push(refusalAudit(settle.tenantId, settle.actor, row.id, tombstone));
    tx.audit.push(...settle.audit);
  });
  return { changed: true, refused: tombstone !== undefined };
}

/** Current distilled rows sharing their bare text with another, and each partition in the order it first appears. */
function duplicateCandidatesIn(t: MemoryTables) {
  const current = [...t.entries.values()]
    .filter((e) => (e.kind ?? 'distilled') === 'distilled' && !e.supersededBy)
    .sort(oldestFirst);
  const counts = new Map<string, number>();
  for (const e of current) counts.set(bareText(e.content), (counts.get(bareText(e.content)) ?? 0) + 1);
  const firstSeen = new Map<string, { tenantId: string; scope: string | null; originProject: string | null }>();
  const firstAt = (e: MemoryEntry): string => `${e.created}\u001f${e.id}`;
  for (const e of [...current].sort((a, b) => byBytes(firstAt(a), firstAt(b)))) {
    const key = JSON.stringify([e.tenantId, e.scope ?? null, e.originProject ?? null]);
    if (!firstSeen.has(key)) {
      firstSeen.set(key, { tenantId: e.tenantId, scope: e.scope ?? null, originProject: e.originProject ?? null });
    }
  }
  const rows = current.filter((e) => (counts.get(bareText(e.content)) ?? 0) > 1);
  return { rows: structuredClone(rows), firstSeen: [...firstSeen.values()] };
}

function recordSleepIn(
  t: MemoryTables,
  { conflicts, at, decayed, merged, removed }: Parameters<Consolidation['recordSleep']>[0],
) {
  replaceConflictsIn(t, conflicts, at);
  const after = t.sleepRuns.findIndex((run) => byBytes(run.timestamp, at) > 0);
  t.sleepRuns.splice(after < 0 ? t.sleepRuns.length : after, 0, { timestamp: at, decayed, merged, removed });
  t.sleepRuns.splice(0, Math.max(0, t.sleepRuns.length - CONSOLIDATION_RUNS_KEPT));
  t.meta.set('sleep_count', String((Number(t.meta.get('sleep_count') ?? '0') || 0) + 1));
}

export function memoryConsolidation(t: MemoryTables): Consolidation {
  const entries = (): MemoryEntry[] => [...t.entries.values()].sort(oldestFirst);
  const topics = (): MemoryEntry[] =>
    entries().filter((e) => e.dagLevel === DAG_LEVEL.topic && !e.dagParentId && live(e));
  return {
    begin: async (to, opts) => beginIn(t, to, opts),
    async entryIdsPage(page) {
      const { items, next } = pageAfter(entries(), page, (e) => e.id);
      return { ids: items, next };
    },
    rejected: async (tenantId, digests) =>
      structuredClone([...new Set(digests)].flatMap((d) => t.rejected.get(tenantKey(tenantId, d)) ?? [])),
    particleIds: async () => [...t.particles.keys()],
    async saveParticles(particles) {
      for (const p of particles) t.particles.set(p.memoryId, storedParticle(p, p.memoryId));
    },
    dirtySummaries: async (limit) => dirtySummariesIn(t, limit),
    async unprofiledTopicSummaries(page) {
      const { items, next } = pageAfter(topics(), page, (e) => structuredClone(e));
      return { entries: items, next };
    },
    settleSummary: async (settle) => settleIn(t, settle),
    commit: async (commit) => commitIn(t, commit),
    recordSleep: async (record) => recordSleepIn(t, record),
    async auditEachRow(events) {
      for (const event of events) appendAudit(t, [event]);
      return 0;
    },
    duplicateCandidates: async () => duplicateCandidatesIn(t),
    dirtyGraphTenants: async () => [],
    markGraphDrained: async () => 0,
  };
}
