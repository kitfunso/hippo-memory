// hippo.db's Consolidation group: sleep's reads and writes, each a body on one short-lived handle.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { type DatabaseSyncLike, withWriteScope, getMeta, setMeta, SLEEP_DB_WAIT_MS } from '../../db/index.js';
import { rejectedValues } from './rejection.js';
import { ftsDrift } from './entry-row.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { WRITE_BUDGET } from '../../base/util/write-budget.js';
import {
  planHalfLifeMoves,
  type HalfLifeMove,
  type HalfLifeOutcome,
  type HalfLifeRow,
  type HalfLifeRows,
} from '../../base/memory/half-life-plan.js';
import type {
  Consolidation,
  SleepBegin,
  SleepCommit,
  SleepCommitted,
  SleepStart,
} from '../../base/ports/store/consolidation.js';
import { appendAuditEvents } from './audit.js';
import { conflictResolveAudits, resolvedConflicts, replaceDetectedConflicts } from './conflicts.js';
import {
  iterateEveryTenantEntries,
  iterateRowsWithObjects,
  listDuplicateCandidates,
  listEntryIdsPage,
} from './entry-reads.js';
import { setHalfLives } from './entry-writes.js';
import { type Handles, type StoreFiles, waitingOpener } from './open.js';
import { halfLifeAuditRows, recordedHalfLifeBase } from '../rules/half-life.js';
import { commitInChunks } from './delete-and-batch.js';
import { expireDormantBefore } from './dormant.js';
import { listPendingExtractionTenants, markPendingProcessedUpTo } from './graph-queue.js';
import { appendConsolidationRun, incrementSleepCount, readSleepHistory } from './index-and-stats.js';
import { listPromotableSessions, traceExistsForSession } from './sessions.js';
import { saveStoredParticles, storedParticleIds } from './vector-index.js';
import { openStore } from './handles.js';
import { bound, type Bodies } from './bound.js';
import { rethrowInPortTerms } from './port-errors.js';
import { auditRows, dirtySummaries, listL2SummariesPage, settleSummary } from './consolidation-summaries.js';
import { META_KEY } from '../../db/meta.js';

// A half-life move reads, writes, audits and records its base on one handle, so it commits whole or not at all.
function listHalfLifeRows(db: DatabaseSyncLike, from: number, typedPending: boolean): HalfLifeRows {
  return {
    from,
    typedPending,
    conflictAudits: typedPending ? conflictResolveAudits(db) : [],
    resolvedConflicts: typedPending ? resolvedConflicts(db) : [],
    rows: typedPending ? iterateRowsWithObjects(db) : withoutObjects(iterateEveryTenantEntries(db)),
  };
}

function* withoutObjects(entries: Iterable<MemoryEntry>): Generator<HalfLifeRow> {
  for (const entry of entries) yield { entry, object: null };
}

/** Writes the move, then its audit rows one statement each. */
function writeMove(db: DatabaseSyncLike, move: HalfLifeMove, actor: string): void {
  setHalfLives(
    db,
    move.entries.map((e) => ({ id: e.id, halfLifeDays: e.halfLifeDays })),
  );
  for (const row of halfLifeAuditRows(move, actor)) appendAuditEvents(db, [row]);
}

/** Moves the store's half-lives to base `to` as planned from the rows read here, then records the base. `outcome` is
 * null when no move is due; a dry run plans and writes nothing. */
function moveHalfLives(
  db: DatabaseSyncLike,
  to: number,
  opts: { dryRun: boolean; actor: string },
): { from: number; outcome: HalfLifeOutcome | null } {
  const run = () => {
    const from = recordedHalfLifeBase(getMeta(db, META_KEY.halfLifeBase, ''));
    const typedPending = getMeta(db, META_KEY.typedHalfLife, '') === '';
    if (!(Number.isFinite(to) && to > 0) || (from === to && !typedPending)) return { from, outcome: null };
    const { moves, outcome } = planHalfLifeMoves(listHalfLifeRows(db, from, typedPending), to);
    if (opts.dryRun) return { from, outcome };

    for (const move of moves) writeMove(db, move, opts.actor);
    setMeta(db, META_KEY.halfLifeBase, String(to));
    setMeta(db, META_KEY.typedHalfLife, '1');
    return { from, outcome };
  };
  // Plan, write, audit and record the base under one write lock, so a concurrent write or sleep cannot interleave.
  return opts.dryRun ? run() : withWriteScope(db, 'migrate_half_life', run);
}

/** The tenant's sessions completed since `sinceMs` that hold no trace yet. */
function untracedSessions(db: DatabaseSyncLike, { tenantId, sinceMs }: NonNullable<SleepBegin['traces']>): string[] {
  return listPromotableSessions(db, tenantId, sinceMs)
    .map((row) => row.session_id)
    .filter((sessionId) => !traceExistsForSession(db, tenantId, sessionId));
}

function begin(db: DatabaseSyncLike, to: number, opts: SleepBegin): SleepStart {
  const { from, outcome } = moveHalfLives(db, to, opts);
  const fts = ftsDrift(db, !opts.dryRun);
  const sessions = opts.traces ? untracedSessions(db, opts.traces) : [];
  return { from, outcome, fts, ...readSleepHistory(db), sessions };
}

// The wait is sleep's own, not a server request's 250 ms.
const sleepOpener = waitingOpener(SLEEP_DB_WAIT_MS);
const sleepStoreOpener = waitingOpener(SLEEP_DB_WAIT_MS, openStore);

async function commitSleep(db: DatabaseSyncLike, files: StoreFiles, commit: SleepCommit): Promise<SleepCommitted> {
  const budget = { ...WRITE_BUDGET, holdMs: commit.holdMs };
  const { flush, expireBefore, dryRun } = commit;
  const removedIds = flush
    ? await commitInChunks(db, files, flush.components, { snapshot: flush.snapshot, budget })
    : [];
  const expired = expireBefore === null ? 0 : await expireDormantBefore(db, expireBefore, { dryRun, budget });
  return { removedIds, expired };
}

/** The chunked writes keep their handle until their Promise settles; a commit with nothing to write opens none, and
 * one that only expires opens a bare handle, so a dry run sets up no mirror folder. */
function chunkedCommit({ onAsync }: Handles): Consolidation['commit'] {
  return (commit) => {
    const flush = commit.flush && commit.flush.components.length > 0 ? commit.flush : null;
    if (!flush && commit.expireBefore === null) return Promise.resolve({ removedIds: [], expired: 0 });
    const opener = flush ? sleepStoreOpener : sleepOpener;
    return onAsync((db, files) => commitSleep(db, files, { ...commit, flush }), opener).catch(rethrowInPortTerms);
  };
}

type StoreBodies = 'begin' | 'entryIdsPage' | 'duplicateCandidates' | 'dirtySummaries' | 'unprofiledTopicSummaries';

const storeBodies: Bodies<Pick<Consolidation, StoreBodies | 'settleSummary'>> = {
  begin,
  entryIdsPage: (db, page) => listEntryIdsPage(db, ALL_TENANTS, page),
  duplicateCandidates: listDuplicateCandidates,
  dirtySummaries,
  unprofiledTopicSummaries: listL2SummariesPage,
  settleSummary,
};

function recordSleepBody(files: StoreFiles): Bodies<Pick<Consolidation, 'recordSleep'>> {
  return {
    recordSleep: (db, { conflicts, at, decayed, merged, removed }) => {
      replaceDetectedConflicts(db, files, conflicts, at);
      appendConsolidationRun(db, files, { timestamp: at, decayed, merged, removed });
      incrementSleepCount(db);
    },
  };
}

type BareBodies = 'rejected' | 'particleIds' | 'saveParticles' | 'auditEachRow' | 'dirtyGraphTenants';

const bareBodies: Bodies<Pick<Consolidation, BareBodies | 'markGraphDrained'>> = {
  rejected: (db, tenantId, digests) => {
    const found = rejectedValues(db, tenantId, digests);
    return [...new Set(digests)].flatMap((digest) => found.get(digest) ?? []);
  },
  particleIds: storedParticleIds,
  saveParticles: saveStoredParticles,
  auditEachRow: auditRows,
  dirtyGraphTenants: listPendingExtractionTenants,
  markGraphDrained: markPendingProcessedUpTo,
};

/** Sleep's store work on its hippo.db, each call on its own short-lived handle. */
export function sqliteConsolidation(handles: Handles): Consolidation {
  const { on, files } = handles;
  return {
    ...bound(on, storeBodies, openStore),
    ...bound(on, recordSleepBody(files), openStore),
    ...bound(on, bareBodies),
    commit: chunkedCommit(handles),
  };
}
