/**
 * Consolidation engine ("Sleep") for Hippo.
 *
 * Steps:
 * 1. Decay pass  - remove entries below strength threshold
 * 2. Merge pass  - find episodic entries with high text overlap, create semantic summaries
 * 3. Stats tracking
 */

import { evalNow, isRecallBoostAblated } from './ablation.js';
import { MemoryEntry, Layer, calculateStrength, canAutoDelete, createMemory, markRetrieved, type DecayOptions } from './memory.js';
import { writeEntry } from './store/entry-writes.js';
import { loadAllEntries } from './store/entry-reads.js';
import { deleteEntry, batchWriteAndDelete, memoriesBackingObjects } from './store/delete-and-batch.js';
import { appendConsolidationRun, loadSessionDecayContext, incrementSleepCount } from './store/index-and-stats.js';
import { findPromotableSessions, traceExistsForSession, listSessionEvents } from './store/sessions.js';
import { replaceDetectedConflicts } from './store/conflicts.js';
import { tokenize } from './tokenize.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { compareEntryIdentity } from './compare.js';
import { duplicateKey, mergedText } from './same-text.js';
import { successorAfterRetirement } from './merged-row.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import { rejectionDigest, findRejectedValue } from './rejection.js';
import { countExpiredDormant, purgeExpiredDormant, type DormantMove } from './dormant.js';
import { detectSecret } from './secret-detect.js';
import { loadPhysicsState, savePhysicsState, refreshParticleProperties } from './physics-state.js';
import { simulate, type ForceContext } from './physics.js';
import { loadConfig } from './config.js';
import { sampleForReplay } from './replay.js';
import { renderTraceContent } from './trace.js';
import { resolveTenantId } from './tenant.js';
import { rescueSet, rankNonPinnedByTenant, validateWeights, type MvRankInfo } from './memory-value.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from './memory-value-weights.js';
import { appendAuditEvent, reportAuditWriteFailure } from './audit.js';
import { migrateDefaultHalfLife, LEGACY_TYPED_HALF_LIFE } from './half-life-migration.js';
import { derivationScope, commonDerivationScope, derivationPartitionKey } from './recall-scope.js';
import { isQuarantineScope } from './quarantine.js';
import { NO_MERGE_TAGS } from './shared.js';
import { log } from './log.js';

const DECAY_THRESHOLD = 0.05;
const MERGE_OVERLAP_THRESHOLD = 0.35;  // Jaccard similarity for "related"
const MERGE_MIN_CLUSTER = 2;            // minimum cluster size to merge
const MERGE_MAX_SOURCES = 5;            // with MERGE_MAX_CHARS, keeps a merged row near 500 tokens, a third of the 1,500-token context budget
const MERGE_MAX_CHARS = 2000;           // total source text; sources past either cap stay unmerged and keep their half-life
// Half-life scale for merged source episodics. Demotion must go through
// half_life_days: calculateStrength() recomputes live strength from
// last_retrieved/half_life and never reads the stored strength field, so a
// stored-strength write is inert for ranking and gets overwritten by the
// next sleep's decay pass anyway.
const MERGE_SOURCE_HALF_LIFE_FACTOR = 0.3;
// Contradictions should be gated by content overlap, not shared tags. Tags like
// `feedback` / `policy` are too coarse and can make unrelated rules look like
// conflicts before the polarity heuristics run.
// Jaccard threshold on stopword-filtered tokens. Only applied after a polarity
// signal has already been detected (explicit pair or inferred negation), so
// this just filters out drive-by topic similarity, not semantic drift.
const CONFLICT_OVERLAP_THRESHOLD = 0.5;
// Minimum distinctive shared tokens before we trust an overlap score. Filters
// out cases where two memories share only common English + a project name.
const CONFLICT_MIN_RARE_SHARED = 2;
// Polarity is detected on the first N words only. A stray "not" in the middle
// of a long memory shouldn't flip the whole thing negative.
const POLARITY_WINDOW_WORDS = 40;

const CONFLICT_STOPWORDS = new Set([
  'the','a','an','is','was','are','were','be','been','being','to','of','in',
  'for','on','with','at','by','from','it','this','that','and','or','but','so',
  'if','as','we','i','you','they','he','she','my','our','your','its','his',
  'her','their','up','out','just','also','then','than','some','all','any',
  'each','very','too','do','did','does','has','had','have','will','would',
  'could','should','may','might','can','shall','when','where','what','which',
  'who','how','why','there','here','about','into','over','after','before',
  'between','through','during','against','within','without','toward','upon',
  'more','most','less','least','other','such','same','new','old','one','two',
]);

export interface ConsolidationResult {
  decayed: number;
  removed: number;
  /** Faded memories moved to the dormant store instead of deleted (config
   *  `dormant.enabled`; src/dormant.ts). Always 0 when that is off. */
  dormant: number;
  /** Dormant memories deleted for good this sleep because they outlived
   *  `dormant.retentionDays` without a restore. */
  dormantExpired: number;
  merged: number;
  semanticCreated: number;
  replayed: number;
  promotedTraces: number;
  /** T7: sessions skipped because their events span two derivation scopes. */
  tracesSkippedMixedScope: number;
  extractionCandidates: number;
  extracted: number;
  dagCandidateClusters: number;
  dagSummariesCreated: number;
  // v0.30 / E3 — rebuild phase observability. Failed and zero-child counts
  // are first-class so downstream callers (CLI eval, HTTP /v1/sleep response)
  // see structured data, not a parsed details string.
  summariesRebuilt: number;
  summariesRebuildFailed: number;
  summariesZeroChildSkipped: number;
  // Hardening pass: tombstone-refused rebuilds split out of `rebuilt` so the
  // stat no longer silently absorbs refusals (metadata still applied, dirty
  // still cleared - counters only; see applyRebuildResult's return contract).
  summariesRebuildRefused: number;
  summariesRebuildCapped: boolean;
  // v0.30 / E5 — L3 entity-profile build count
  entityProfilesCreated: number;
  dryRun: boolean;
  details: string[];
  physicsSimulated: number;
  /** Ids the decay pass removes (or would remove, under dryRun). */
  removedIds?: string[];
}

const REPLAY_COUNT_DEFAULT = 5;

function keptAsWritten(entry: MemoryEntry): boolean {
  return entry.tags.some((tag) => NO_MERGE_TAGS.has(tag));
}

/** JSON value shape for a session event's free-form metadata field, cast to
 *  once at its `Record<string, unknown>` origin so it can be narrowed via
 *  isJsonString below rather than left as unparsed `unknown`. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function isJsonString(value: JsonValue): value is string {
  return typeof value === 'string';
}

/**
 * Run a full consolidation pass.
 */
export async function consolidate(
  hippoRoot: string,
  options: { dryRun?: boolean; now?: Date; fetcher?: typeof fetch } = {}
): Promise<ConsolidationResult> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const dryRun = options.dryRun ?? false;
  const result = newConsolidationResult(dryRun);
  const halfLife = migrateHalfLives(hippoRoot, dryRun, result);

  // L9: host-wide by design. Consolidation runs across all tenants in one
  // pass — per-tenant filtering would create N consolidation runs per host
  // with no cross-tenant dedup. The api.sleep audit row tags this with the
  // admin synthetic actor; see api.ts:2050 for the rationale.
  const all = loadAllEntries(hippoRoot);
  if (dryRun) for (const e of all) e.half_life_days = halfLife.halfLives.get(e.id) ?? e.half_life_days;
  const backingObjects = memoriesBackingObjects(hippoRoot);
  // Retirable: auto-deletable (never pinned, raw or kept for good) and not backing a first-class object.
  const retirable = (entry: MemoryEntry): boolean => canAutoDelete(entry) && !backingObjects.has(entry.id);
  const snapshot = new Map(structuredClone(all).map((e) => [e.id, e]));

  // Load decay options from config + session context
  const config = loadConfig(hippoRoot);
  const sessionCtx = loadSessionDecayContext(hippoRoot);
  const decayOpts: DecayOptions = {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
  };

  const consolidateDb = lazyConsolidateDb(hippoRoot, dryRun);
  const run: SleepRun = {
    hippoRoot, now, dryRun, config, decayOpts, result, all, retirable,
    getConsolidateDb: consolidateDb.get,
    survivors: [],
    // Collect all writes/deletes and batch them at the end
    pendingWrites: [],
    pendingDeletes: [],
    pendingDormant: [],
  };

  const decay = decayPass(run);

  let mergesSkippedRejected = 0;
  try {
    promoteSessionTraces(run);
    replayPass(run);
    await llmPasses(run, options.fetcher);
    physicsPass(run);
    retireHeldTexts(run);
    mergesSkippedRejected = mergePass(run);
  } finally {
    consolidateDb.close();
  }

  if (mergesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`,
    );
  }

  flushPending(run, snapshot);
  expireDormant(run);
  if (!dryRun) logRun(run, decay);
  return result;
}

// A changed default half-life moves memories still on the old base first,
// so this pass decays them at the new one (src/half-life-migration.ts).
function migrateHalfLives(hippoRoot: string, dryRun: boolean, result: ConsolidationResult): ReturnType<typeof migrateDefaultHalfLife> {
  const halfLife = migrateDefaultHalfLife(hippoRoot, loadConfig(hippoRoot).defaultHalfLifeDays, { dryRun });
  if (halfLife.rescaled > 0) {
    result.details.push(`  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.rescaled} memories from the ${halfLife.from}-day to the ${halfLife.to}-day half-life`);
  }
  if (halfLife.typed > 0) {
    result.details.push(`  ⏳ ${dryRun ? 'would move' : 'moved'} ${halfLife.typed} memories of decisions, incidents and other objects from the ${LEGACY_TYPED_HALF_LIFE}-day to the ${halfLife.to}-day half-life`);
  }
  return halfLife;
}

/** The sleep's one tombstone-check handle: opened on first use, never under dryRun, closed once. */
interface LazyDb {
  get: () => DatabaseSyncLike | null;
  close: () => void;
}

// AT1 rejection-guard db handle (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
// covers BOTH the auto-promote pass (1.4) and the merge
// pass (3) — both build deterministic content that
// batchWriteAndDelete writes through the guard's bypass, so both need a
// producer-side tombstone check before pushing to pendingWrites.
//
// T3 fix (2026-08-15 hardening pass, perf hygiene): memoized lazy getter,
// not an eager open. The handle only serves these two tombstone checks —
// a sleep with zero promotable sessions and zero merge clusters never
// reaches either use site, so opening it unconditionally on every
// non-dry-run sleep paid a db-open cost for nothing. dryRun still never
// opens (getConsolidateDb short-circuits before touching the handle).
// consolidateDbOpened (not just a truthy handle check) is the
// single source of truth for "was this ever opened", so the finally
// closes it exactly once and never double-opens.
//
// AT1 P2 fix (codex, handle-leak restructure): the getter's lifetime must
// start IMMEDIATELY before the try whose finally closes it, covering every
// phase that can touch it — not just the merge pass. An exception thrown by
// auto-promote (1.4), replay (1.5), batch extraction (1.6), the DAG
// passes (1.7-1.9), or physics (2) would otherwise propagate past an open handle
// with nothing to close it.
function lazyConsolidateDb(hippoRoot: string, dryRun: boolean): LazyDb {
  let consolidateDbHandle: DatabaseSyncLike | null = null;
  let consolidateDbOpened = false;
  const get = (): DatabaseSyncLike | null => {
    if (dryRun) return null;
    if (!consolidateDbOpened) {
      consolidateDbHandle = openHippoDb(hippoRoot);
      consolidateDbOpened = true;
    }
    return consolidateDbHandle;
  };
  const close = (): void => {
    if (consolidateDbHandle) closeHippoDb(consolidateDbHandle);
  };
  return { get, close };
}

/** State every sleep stage reads or appends to; the pending lists are flushed in one transaction at the end. */
interface SleepRun {
  hippoRoot: string;
  now: Date;
  dryRun: boolean;
  config: ReturnType<typeof loadConfig>;
  decayOpts: DecayOptions;
  result: ConsolidationResult;
  all: MemoryEntry[];
  retirable: (entry: MemoryEntry) => boolean;
  getConsolidateDb: () => DatabaseSyncLike | null;
  survivors: MemoryEntry[];
  pendingWrites: MemoryEntry[];
  pendingDeletes: string[];
  pendingDormant: DormantMove[];
}

/** What the decay pass hands to the conflict check and the rescue audit at the end of the run. */
interface DecayOutcome {
  rescuedIds: Set<string>;
  rescuedEntries: MemoryEntry[];
  rankById: Map<string, MvRankInfo>;
}

function newConsolidationResult(dryRun: boolean): ConsolidationResult {
  return {
    decayed: 0,
    removed: 0,
    dormant: 0,
    dormantExpired: 0,
    merged: 0,
    semanticCreated: 0,
    replayed: 0,
    promotedTraces: 0,
    tracesSkippedMixedScope: 0,
    extractionCandidates: 0,
    extracted: 0,
    dagCandidateClusters: 0,
    dagSummariesCreated: 0,
    summariesRebuilt: 0,
    summariesRebuildFailed: 0,
    summariesZeroChildSkipped: 0,
    summariesRebuildRefused: 0,
    summariesRebuildCapped: false,
    entityProfilesCreated: 0,
    dryRun,
    details: [],
    physicsSimulated: 0,
  };
}

// A faded, unpinned, unrescued memory leaves active memory one of three
// ways. A raw receipt is append-only: trg_memories_raw_append_only aborts
// a DELETE, and with it this whole cycle's batch and every later sleep,
// so it stays where it is (stored strength refreshed) but sits out the
// rest of this cycle the way a deleted row would. Anything else goes
// dormant when config.dormant is on, and is deleted otherwise.
// Only called for rows `retirable` allows (never pinned, raw, kept for good or backing a first-class object).
function retireFaded(run: SleepRun, entry: MemoryEntry, strength: number): void {
  const { result } = run;
  const why = `(strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})`;
  // A faded secret is deleted, never kept dormant: keeping it would hold a
  // credential on disk that the user reasonably expects forgetting removed.
  if (run.config.dormant.enabled && !detectSecret(entry).flagged) {
    result.dormant++;
    result.details.push(`  💤 dormant ${entry.id} ${why}`);
    run.pendingDormant.push({ entry: { ...entry, strength }, strength, reason: 'decay', dormantAt: run.now.toISOString() });
    return;
  }
  result.removed++;
  result.details.push(`  🗑  removed ${entry.id} ${why}`);
  run.pendingDeletes.push(entry.id);
}

/** Keeps an entry with its live strength cached; only strength is a cached computation, confidence stays as stored. */
function keepSurvivor(run: SleepRun, entry: MemoryEntry, strength: number): MemoryEntry {
  const updated = { ...entry, strength };
  run.survivors.push(updated);
  if (!run.dryRun && strength !== entry.strength) {
    run.pendingWrites.push(updated);
  }
  run.result.decayed++;
  return updated;
}

// -------------------------------------------------------------------------
// 1. Decay pass
// -------------------------------------------------------------------------
// LC2-E3 (opt-in, default off; docs/plans/2026-08-10-lc2-e3-mv-wiring.md):
// flag OFF keeps the single-phase loop below byte-identical to pre-E3
// behavior (pre-registered gate G2). Flag ON restructures into two phases:
// phase 1 classifies every entry (condemned vs survivor) with ZERO
// commits; phase 2 runs rescueSet over the per-tenant candidate groups,
// then commits — rescued entries get the standard survivor bookkeeping
// refresh (stored strength + effective confidence; no half-life edits, no
// rank-derived writes) and are pushed to survivors so they fully
// participate in this cycle's merge/physics/conflict passes; non-rescued
// condemned entries follow the existing pendingDeletes/result.removed/
// details path.
function decayPass(run: SleepRun): DecayOutcome {
  if (run.config.memoryValue.enabled) return decayWithMemoryValue(run);
  for (const entry of run.all) {
    const strength = calculateStrength(entry, run.now, run.decayOpts);

    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      retireFaded(run, entry, strength);
    } else {
      keepSurvivor(run, entry, strength);
    }
  }
  return { rescuedIds: new Set(), rescuedEntries: [], rankById: new Map() };
}

// A non-finite feature (e.g. a malformed `created`) scores -Infinity and can never be
// rescued, so name those entries in one warning rather than leave it a silent NaN detail.
function reportNonFiniteScores(result: ConsolidationResult, rankById: Map<string, MvRankInfo>): void {
  const nonFiniteIds = [...rankById.entries()]
    .filter(([, info]) => !Number.isFinite(info.score))
    .map(([id]) => id);
  if (nonFiniteIds.length > 0) {
    result.details.push(
      `  ⚠️ memory-value: skipped ${nonFiniteIds.length} entr${nonFiniteIds.length === 1 ? 'y' : 'ies'} ` +
      `with non-finite computed features (never rescued): ${nonFiniteIds.join(', ')}`,
    );
  }
}

function decayWithMemoryValue(run: SleepRun): DecayOutcome {
  const { all, now, result } = run;
  // Carried forward to logRun, where the mv_rescue audit rows are actually
  // written (code-review fix: writing them here, before batchWriteAndDelete,
  // would assert rescues for a cycle whose effects might never land if a
  // later phase throws).
  const rescuedEntries: MemoryEntry[] = [];
  let rescuedIds: Set<string> = new Set();
  let rankById: Map<string, MvRankInfo> = new Map();

  // --- Phase 1: classify (zero commits) ---
  const condemned: MemoryEntry[] = [];
  const strengthById = new Map<string, number>();
  for (const entry of all) {
    const strength = calculateStrength(entry, now, run.decayOpts);
    strengthById.set(entry.id, strength);
    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      condemned.push(entry);
    }
  }

  // --- Phase 2a: rescue decision (pure compute) ---
  // Runs under --dry-run too (only the pendingDeletes flush and the audit write in
  // logRun stay !dryRun-gated), so the preview matches what a
  // real run would decide.
  const condemnedIds = new Set(condemned.map((e) => e.id));
  // Fail-loud must not depend on condemnation traffic (round-2 code-review
  // P2-2): validate the frozen weights constant unconditionally, even on a
  // sleep with nothing condemned.
  validateWeights();
  if (condemnedIds.size > 0) {
    // Compute the per-tenant ranking ONCE (round-2 code-review P2-2):
    // rankById feeds both rescueSet's decision (via precomputedRanks,
    // skipping its own internal rankNonPinnedByTenant call) and the
    // detail/audit rank context below, so the whole-store ranking pass
    // runs a single time per sleep instead of twice, and only when there
    // is actually something condemned to rank against.
    rankById = rankNonPinnedByTenant(all, now);
    rescuedIds = rescueSet(all, condemnedIds, now, MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256, rankById);
    reportNonFiniteScores(result, rankById);
  }

  // --- Phase 2b: commit, one pass over `all` in ITS ORIGINAL ORDER ---
  // (review-round F4: rescued entries used to be appended at the tail of
  // survivors, systematically starving them in downstream order-sensitive
  // passes like extraction's slice(0,20) — a single pass over `all`
  // preserves flag-off's ordering semantics exactly.)
  for (const entry of all) {
    const strength = strengthById.get(entry.id)!;
    if (run.retirable(entry) && strength < DECAY_THRESHOLD) {
      if (rescuedIds.has(entry.id)) {
        // Rescued (D1): standard survivor stored-strength refresh (P2-1).
        // Confidence is left alone here: it is an epistemic tier, not a
        // cached computation, so resolveConfidence derives it on read.
        rescuedEntries.push(keepSurvivor(run, entry, strength));
        const rank = rankById.get(entry.id);
        const rankNote = rank
          ? ` - rescued (rank ${rank.rank}/${rank.totalNonPinned} in tenant ${rank.tenantId}, top ${rank.keepN})`
          : ' - rescued';
        result.details.push(`  🛟 ${entry.id} (strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})${rankNote}`);
      } else {
        retireFaded(run, entry, strength);
      }
    } else {
      keepSurvivor(run, entry, strength);
    }
  }
  return { rescuedIds, rescuedEntries, rankById };
}

// -------------------------------------------------------------------------
// 1.4. Auto-promote complete sessions to traces
// -------------------------------------------------------------------------
//
// For each session within the configured window that has a `session_complete`
// event and no existing trace (idempotency via the source_session_id column),
// render the action sequence as markdown and persist a Layer.Trace memory.
// Traces inherit decay, search, replay, and physics from the base MemoryEntry.
function promoteSessionTraces(run: SleepRun): void {
  const { result } = run;
  if (run.dryRun || run.config.autoTraceCapture === false) return;
  let tracesSkippedRejected = 0;
  const windowDays = run.config.autoTraceWindowDays ?? 7;
  const sinceMs = run.now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  // Auto-trace currently runs in a single-tenant context (the env-resolved
  // tenant for this process). Multi-tenant deployments that want
  // consolidation across all tenants need a per-tenant loop layered on top
  // of this — tracked in docs/plans/2026-05-02-continuity-tables-tenant-scope.md.
  const consolidationTenant = resolveTenantId({});
  const promotable = findPromotableSessions(run.hippoRoot, consolidationTenant, sinceMs);

  for (const session of promotable) {
    const built = sessionTrace(run, consolidationTenant, session.session_id);
    if (!built) continue;
    const { trace, outcome } = built;
    if (traceRejected(run, trace, session.session_id)) {
      tracesSkippedRejected++;
      continue;
    }

    run.pendingWrites.push(trace);
    run.survivors.push(trace);
    result.promotedTraces++;
    result.details.push(
      `  🧬 promoted trace ${trace.id} from session ${session.session_id} (${outcome})`
    );
  }

  if (result.promotedTraces > 0) {
    result.details.push(
      `  🧬 promoted ${result.promotedTraces} trace${result.promotedTraces === 1 ? '' : 's'} from completed session${result.promotedTraces === 1 ? '' : 's'}`
    );
  }
  if (tracesSkippedRejected > 0) {
    log.warn(
      `consolidate: skipped ${tracesSkippedRejected} auto-promoted trace(s) whose content matches a rejected value`,
    );
  }
}

type TraceOutcome = 'success' | 'failure' | 'partial';

/** The trace a completed session renders to, or null when it already has one or cannot be promoted. */
function sessionTrace(run: SleepRun, consolidationTenant: string, sessionId: string): { trace: MemoryEntry; outcome: TraceOutcome } | null {
  // Idempotency: skip if a trace for this session already exists.
  if (traceExistsForSession(run.hippoRoot, consolidationTenant, sessionId)) return null;

  const events = listSessionEvents(run.hippoRoot, consolidationTenant, {
    session_id: sessionId,
    limit: 1000,
  });

  // T7: a mixed-scope session would otherwise leak into one trace.
  const sessionScope = commonDerivationScope(events.map((e) => e.scope));
  if (!sessionScope.ok) {
    run.result.tracesSkippedMixedScope++;
    run.result.details.push(`  ⏭  skipped session ${sessionId}: events span mixed scopes`);
    return null;
  }

  const completeEvent = events.find((e) => e.event_type === 'session_complete');
  if (!completeEvent) return null; // defence-in-depth; findPromotableSessions filters already.

  const outcomeRaw = completeEvent.content;
  if (outcomeRaw !== 'success' && outcomeRaw !== 'failure' && outcomeRaw !== 'partial') {
    // Malformed terminal event — skip rather than crash the whole sleep.
    return null;
  }
  const outcome: TraceOutcome = outcomeRaw;

  const steps = events
    .filter((e) => e.event_type !== 'session_complete')
    .map((e) => ({ action: e.content, observation: '' }));

  // SAFETY: session event metadata is a free-form Record<string, unknown>
  // bag; summary is optional and is only trusted once isJsonString below
  // confirms it is actually a string.
  const summaryValue = completeEvent.metadata.summary as JsonValue;
  const summary = isJsonString(summaryValue) ? summaryValue : '(untitled)';

  const trace = createMemory(
    renderTraceContent({ task: summary, steps, outcome }),
    {
      layer: Layer.Trace,
      trace_outcome: outcome,
      source_session_id: sessionId,
      tags: ['auto-promoted'],
      source: 'auto-promote',
      scope: sessionScope.scope,
      // T1 fix (2026-08-15 hardening pass): stamp the trace into the SAME
      // tenant the traceExistsForSession idempotency check (above) runs
      // under. Before
      // this, createMemory omitted tenantId and the trace always landed
      // 'default' (memory.ts:535) while the idempotency check ran under
      // consolidationTenant — for any non-default tenant that check never
      // hit, and the trace regenerated every sleep.
      tenantId: consolidationTenant,
      baseHalfLifeDays: run.config.defaultHalfLifeDays,
    },
  );
  return { trace, outcome };
}

// AT1 (same producer-side pattern as the merge pass below): traceExistsForSession
// only sees rows CURRENTLY in the store — once a rejected trace is
// removed, that idempotency check no longer blocks regeneration, and
// this write would otherwise reach batchWriteAndDelete's guard bypass
// unchecked, resurrecting it every sleep. Check under THE ENTRY'S OWN
// stamped tenantId (read off `trace` after createMemory — never guess
// the tenant) + the built content's digest. A hit skips the push
// entirely: not counted as promoted, not added to survivors.
function traceRejected(run: SleepRun, trace: MemoryEntry, sessionId: string): boolean {
  const consolidateDb = run.getConsolidateDb();
  if (!consolidateDb) return false;
  const traceDigest = rejectionDigest(trace.content);
  const tombstone = findRejectedValue(consolidateDb, trace.tenantId, traceDigest);
  if (!tombstone) return false;
  try {
    appendAuditEvent(consolidateDb, {
      tenantId: trace.tenantId,
      actor: 'sleep',
      op: 'reject_refusal',
      metadata: {
        digest: traceDigest,
        reason: tombstone.reason,
        sourceSessionId: sessionId,
      },
    });
  } catch (error) {
    reportAuditWriteFailure('reject_refusal', String(error));
  }
  return true;
}

// -------------------------------------------------------------------------
// 1.5. Replay pass — rehearse high-value survivors
// -------------------------------------------------------------------------
//
// Biologically-inspired counterpart to hippocampal replay during slow-wave
// sleep: sample N memories weighted by outcome + valence + under-rehearsal
// + idle time, then apply the same retrieval-strengthening `markRetrieved`
// applies to real queries. Distinct from decay (removal), physics (motion),
// and merge (compression) — this is the "rehearse the important stuff so
// it doesn't fade" pass.
function replayPass(run: SleepRun): void {
  const { survivors, now } = run;
  const replayCount = run.config.replay?.count ?? REPLAY_COUNT_DEFAULT;
  // EVAL-ONLY ablation (see ablation.ts): replay rehearsal IS recall
  // strengthening (same markRetrieved dynamics), so the strengthen-off arm
  // silences the whole pass - markRetrieved would return unmutated entries
  // and persisting them anyway would still refresh updated_at / mirrors.
  if (!(replayCount > 0 && survivors.length > 0 && !isRecallBoostAblated())) return;
  const seed = Math.floor(now.getTime() / 1000) & 0xffffffff;
  const picked = sampleForReplay(survivors, replayCount, now, seed);
  if (picked.length === 0) return;
  const rehearsed = markRetrieved(picked, now);
  const rehearsedById = new Map(rehearsed.map((e) => [e.id, e]));
  // Update survivors in place so downstream passes see rehearsed state.
  for (let i = 0; i < survivors.length; i++) {
    const replacement = rehearsedById.get(survivors[i].id);
    if (replacement) survivors[i] = replacement;
  }
  run.result.replayed = rehearsed.length;
  run.result.details.push(
    `  💭 replayed ${rehearsed.length} memor${rehearsed.length === 1 ? 'y' : 'ies'}: ` +
    rehearsed.map((e) => e.id).join(', ')
  );
  if (!run.dryRun) {
    for (const r of rehearsed) run.pendingWrites.push(r);
  }
}

/** The key, model options and once-per-line error reporter every LLM phase shares. */
function sleepLlm(run: SleepRun, fetcher: typeof fetch | undefined) {
  const { config, result } = run;
  // extraction.enabled=false is the opt-out for every LLM phase below, key or no key.
  const apiKey = config.extraction.enabled !== false ? (process.env.ANTHROPIC_API_KEY ?? '') : '';
  const llmErrorsSeen = new Set<string>();
  const llmError = (phase: string) => (msg: string): void => {
    const line = `  ⚠️ ${phase}: ${msg}`;
    if (llmErrorsSeen.has(line)) return;
    llmErrorsSeen.add(line);
    result.details.push(line);
    log.warn(`consolidate ${phase}: ${msg}`);
  };
  const llmOpts = { apiKey, model: config.extraction.model, fetcher };
  return { apiKey, llmError, llmOpts };
}

type SleepLlm = ReturnType<typeof sleepLlm>;

async function llmPasses(run: SleepRun, fetcher: typeof fetch | undefined): Promise<void> {
  // -------------------------------------------------------------------------
  // 1.6. Batch extraction — extract facts from episodic memories missing them
  // -------------------------------------------------------------------------
  const extractedFromIds = new Set(
    run.survivors.filter((e) => e.extracted_from).map((e) => e.extracted_from!),
  );
  const extractionCandidates = run.survivors.filter(
    (e) => e.layer === Layer.Episodic && !e.superseded_by && !extractedFromIds.has(e.id) && !keptAsWritten(e),
  );
  run.result.extractionCandidates = extractionCandidates.length;

  const llm = sleepLlm(run, fetcher);
  if (llm.apiKey && extractionCandidates.length > 0 && !run.dryRun) {
    const { extractFacts, storeExtractedFacts } = await import('./extract.js');
    const batchLimit = 20;
    let extractedCount = 0;
    for (const candidate of extractionCandidates.slice(0, batchLimit)) {
      try {
        const facts = await extractFacts(candidate.content, { ...llm.llmOpts, onError: llm.llmError('extraction') });
        if (facts.length > 0) {
          storeExtractedFacts(run.hippoRoot, candidate, facts);
          extractedCount += facts.length;
        }
      } catch (err) {
        llm.llmError('extraction')(String(err));
      }
    }
    run.result.extracted = extractedCount;
  }

  await dagBuildPass(run, llm);
  if (llm.apiKey && !run.dryRun) {
    await dagRebuildPass(run, llm);
    await entityProfilePass(run, llm);
  }
}

// -------------------------------------------------------------------------
// 1.7. DAG summarization — cluster extracted facts and generate summaries
// -------------------------------------------------------------------------
async function dagBuildPass(run: SleepRun, { apiKey, llmError, llmOpts }: SleepLlm): Promise<void> {
  const extractedFacts = run.survivors.filter(
    (e) => e.tags.includes('extracted') && e.dag_level === 1 && !e.superseded_by,
  );
  if (!(apiKey && extractedFacts.length >= 3 && !run.dryRun)) return;
  try {
    const { buildDag } = await import('./dag.js');
    const dagResult = await buildDag(run.hippoRoot, extractedFacts, { ...llmOpts, onError: llmError('dag') });
    run.result.dagCandidateClusters = dagResult.candidateClusters;
    run.result.dagSummariesCreated = dagResult.summariesCreated;
    if (dagResult.summariesCreated > 0) {
      run.result.details.push(`  🌳 DAG: ${dagResult.summariesCreated} summaries created, ${dagResult.factsLinked} facts linked`);
    }
  } catch (err) {
    llmError('dag')(String(err));
  }
}

// -------------------------------------------------------------------------
// 1.8. DAG summary rebuild — drain dirty queue from E2's child-write hooks
// -------------------------------------------------------------------------
// Consumer of E2's summary_dirty flag. Walks dirty L2 summaries, regenerates
// each via generateDagSummary, atomically refreshes content + 6 metadata
// columns + clears summary_dirty (with FTS sync). Same apiKey/dryRun gate
// as buildDag above. Cap HIPPO_DAG_REBUILD_CAP (default 20, hard ceiling
// 1000) prevents runaway LLM cost.
async function dagRebuildPass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  const { result } = run;
  try {
    const { rebuildDirtySummaries } = await import('./dag.js');
    const rawCap = parseInt(process.env.HIPPO_DAG_REBUILD_CAP ?? '20', 10);
    // R1 MED must-fix: hard ceiling so misconfigured env can't burn
    // unbounded LLM cost.
    const cap = Number.isFinite(rawCap) && rawCap > 0
      ? Math.min(rawCap, 1000)
      : 20;
    const rebuildResult = await rebuildDirtySummaries(run.hippoRoot, { ...llmOpts, onError: llmError('dag rebuild'), cap });
    result.summariesRebuilt = rebuildResult.rebuilt;
    result.summariesRebuildFailed = rebuildResult.failed;
    result.summariesZeroChildSkipped = rebuildResult.zeroChildSkipped;
    result.summariesRebuildRefused = rebuildResult.refused;
    result.summariesRebuildCapped = rebuildResult.capped;
    if (rebuildResult.rebuilt > 0 || rebuildResult.zeroChildSkipped > 0 || rebuildResult.failed > 0 || rebuildResult.refused > 0) {
      const parts: string[] = [];
      if (rebuildResult.rebuilt > 0) parts.push(`${rebuildResult.rebuilt} rebuilt`);
      if (rebuildResult.refused > 0) parts.push(`${rebuildResult.refused} refused`);
      if (rebuildResult.zeroChildSkipped > 0) parts.push(`${rebuildResult.zeroChildSkipped} zero-child-skipped`);
      if (rebuildResult.failed > 0) parts.push(`${rebuildResult.failed} failed`);
      if (rebuildResult.capped) parts.push(`CAPPED@${cap}`);
      result.details.push(`  🌳 DAG rebuild: ${parts.join(', ')}`);
    }
  } catch (err) {
    llmError('dag rebuild')(String(err));
  }
}

// -------------------------------------------------------------------------
// 1.9. DAG entity profiles — cluster L2 topic summaries into L3 profiles
// -------------------------------------------------------------------------
// E5 phase: aggregate per-entity L2 summaries (e.g. all the speaker:Alice
// topic summaries) into a single L3 entity profile. Runs even when phase
// 1.7 buildDag was skipped (re-clusters existing L2s every sleep).
//
// Uses loadAllL2Summaries (not `survivors`) because phase 1.7 wrote new
// L2s directly via writeEntry without pushing back into survivors.
async function entityProfilePass(run: SleepRun, { llmError, llmOpts }: SleepLlm): Promise<void> {
  try {
    const { buildEntityProfiles } = await import('./dag.js');
    const { loadAllL2Summaries } = await import('./store/summaries.js');
    const l2Summaries = loadAllL2Summaries(run.hippoRoot);
    if (l2Summaries.length >= 2) {
      const profileResult = await buildEntityProfiles(run.hippoRoot, l2Summaries, { ...llmOpts, onError: llmError('dag profiles') });
      run.result.entityProfilesCreated = profileResult.profilesCreated;
      if (profileResult.profilesCreated > 0) {
        run.result.details.push(`  🌲 DAG L3: ${profileResult.profilesCreated} entity profiles, ${profileResult.l2sLinked} L2s linked`);
      }
    }
  } catch (err) {
    llmError('dag profiles')(String(err));
  }
}

// -------------------------------------------------------------------------
// 2. Physics simulation pass
// -------------------------------------------------------------------------
function physicsPass(run: SleepRun): void {
  if (run.dryRun) return;
  const { config, result, survivors } = run;
  try {
    const physicsEnabled = config.physics.enabled === true
      || (config.physics.enabled === 'auto');

    if (physicsEnabled) {
      const db = openHippoDb(run.hippoRoot);
      try {
        const physicsMap = loadPhysicsState(db);
        const particles = Array.from(physicsMap.values());

        if (particles.length > 0) {
          // Build entry lookup for property refresh
          const entryMap = new Map(survivors.map(e => [e.id, e]));
          refreshParticleProperties(particles, entryMap, run.now);

          // Build conflict pairs from survivors
          const conflictPairs = new Map<string, Set<string>>();
          for (const entry of survivors) {
            if (entry.conflicts_with.length > 0) {
              const set = conflictPairs.get(entry.id) ?? new Set<string>();
              for (const cid of entry.conflicts_with) set.add(cid);
              conflictPairs.set(entry.id, set);
            }
          }

          // Build half-life lookup
          const halfLives = new Map<string, number>();
          for (const entry of survivors) {
            halfLives.set(entry.id, entry.half_life_days);
          }

          const ctx: ForceContext = {
            conflictPairs,
            halfLives,
            config: config.physics,
          };

          const stats = simulate(particles, ctx);
          savePhysicsState(db, particles);

          result.physicsSimulated = stats.particleCount;
          result.details.push(
            `  ⚛️  physics: ${stats.particleCount} particles, ` +
            `avg vel ${stats.avgVelocityMagnitude.toFixed(4)}, ` +
            `energy ${stats.energy.total.toFixed(4)}`
          );
        }
      } finally {
        closeHippoDb(db);
      }
    }
  } catch (error) {
    result.details.push(`  ⚠️ physics simulation skipped: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function retireHeldTexts(run: SleepRun): void {
  const { survivors } = run;
  const byId = new Map(run.all.map((e) => [e.id, e]));
  const rejectedIn = (tenantId: string) => (text: string): boolean => {
    const db = run.getConsolidateDb();
    return db !== null && findRejectedValue(db, tenantId, rejectionDigest(text)) !== null;
  };
  for (let i = survivors.length - 1; i >= 0; i--) {
    const row = survivors[i];
    const successor = run.retirable(row) ? successorAfterRetirement(row, byId, rejectedIn(row.tenantId)) : undefined;
    if (successor === undefined) continue;
    run.result.details.push(`  ✂️  ${row.id} held a retired text${successor ? `, ${successor.id} holds the rest` : ''}`);
    if (run.dryRun) continue;
    run.pendingDeletes.push(row.id);
    if (successor) {
      run.pendingWrites.push(successor);
      survivors[i] = successor;
    } else {
      survivors.splice(i, 1);
    }
  }
}

/** The tenant, scope and origin every row merged out of one partition inherits. */
interface MergePartition {
  tenantId: string;
  scope: ReturnType<typeof derivationScope>;
  origin: MemoryEntry['origin_project'];
}

// -------------------------------------------------------------------------
// 3. Merge pass  - episodic entries only
// -------------------------------------------------------------------------
/** Returns how many clusters were skipped because their merged text matches a rejected value. */
function mergePass(run: SleepRun): number {
  const alreadyMergedIds = new Set(run.survivors.flatMap((e) => e.parents));
  const mergeCandidates = run.survivors.filter(
    (e) => e.layer === Layer.Episodic && !e.superseded_by && !keptAsWritten(e) && !alreadyMergedIds.has(e.id)
      && !e.pinned // a pin merged with a look-alike would read as one of two values
      && tokenize(e.content).length > 0, // two empty token sets overlap 1, so tokenless text would merge with any other
  );
  const used = new Set<string>();

  // T1 fix (2026-08-15 hardening pass): partition by tenantId BEFORE the
  // overlap loop so a cluster can never span tenants. Previously textOverlap
  // clustered across the whole host-wide `survivors` list with no tenant
  // boundary, and mergeContents concatenated cross-tenant content into one
  // row. Map preserves insertion order, so single-tenant stores (every row
  // 'default') get exactly one partition and iterate in the same order as
  // before this fix — byte-identical behavior there.
  const mergeCandidatesByTenant = new Map<string, MemoryEntry[]>();
  for (const entry of mergeCandidates) {
    const key = derivationPartitionKey(entry.tenantId, entry.scope, entry.origin_project);
    const bucket = mergeCandidatesByTenant.get(key);
    if (bucket) bucket.push(entry);
    else mergeCandidatesByTenant.set(key, [entry]);
  }

  // AT1 consolidation-loop fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
  // reuses the single consolidateDb handle opened lazily in consolidate()
  // for the whole non-dry-run consolidate — see that
  // declaration's comment. Only needed for real writes — a dry-run preview
  // never reaches batchWriteAndDelete's guard bypass, so there is nothing
  // here for it to protect against.
  let mergesSkippedRejected = 0;
  for (const [, tenantCandidates] of mergeCandidatesByTenant) {
    const partition: MergePartition = {
      tenantId: tenantCandidates[0].tenantId,
      scope: derivationScope(tenantCandidates[0].scope),
      origin: tenantCandidates[0].origin_project,
    };
    const partnersOf = mergePartners(tenantCandidates.map((e) => e.content));
    for (let i = 0; i < tenantCandidates.length; i++) {
      if (used.has(tenantCandidates[i].id) || tenantCandidates[i].content.length > MERGE_MAX_CHARS) continue;

      const related: MemoryEntry[] = [tenantCandidates[i]];

      for (const j of partnersOf(i)) {
        if (!used.has(tenantCandidates[j].id)) related.push(tenantCandidates[j]);
      }

      const cluster: MemoryEntry[] = [];
      let clusterChars = 0;
      for (const e of related) {
        if (cluster.length === MERGE_MAX_SOURCES || clusterChars + e.content.length > MERGE_MAX_CHARS) continue;
        cluster.push(e);
        clusterChars += e.content.length;
      }

      if (cluster.length < MERGE_MIN_CLUSTER) continue;
      if (!mergeCluster(run, partition, cluster, related, used)) mergesSkippedRejected++;
    }
  }
  return mergesSkippedRejected;
}

/** Merges one cluster into a semantic row; returns false when a tombstone refuses the merged text. */
function mergeCluster(run: SleepRun, partition: MergePartition, cluster: MemoryEntry[], related: MemoryEntry[], used: Set<string>): boolean {
  const { result, dryRun } = run;
  // Create a semantic summary
  const mergedContent = mergeContents(cluster);
  const allTags = Array.from(new Set(cluster.flatMap((e) => e.tags))).sort();
  const maxValence = pickStrongestValence(cluster);

  // AT1 P2 fix: build the semantic entry FIRST — createMemory is cheap
  // and pure — so the tombstone check below runs under the tenant the
  // row will ACTUALLY land in.
  // T1 fix: createMemory now receives tenantId: mergeTenant (the
  // partition's tenant — every member of `cluster` shares it by
  // construction), so the row lands in its source tenant instead of
  // always 'default'.
  let semantic: MemoryEntry | null = null;
  if (!dryRun) {
    semantic = {
      ...createMemory(mergedContent, {
        layer: Layer.Semantic,
        tags: allTags,
        emotional_valence: maxValence,
        schema_fit: 0.7,
        source: 'consolidation',
        confidence: 'inferred',
        tenantId: partition.tenantId,
        scope: partition.scope,
        baseHalfLifeDays: run.config.defaultHalfLifeDays,
      }),
      origin_project: partition.origin,
      parents: cluster.map((e) => e.id),
    };
  }

  if (semantic && mergeRejected(run, semantic, cluster, related, used)) return false;

  // Mark cluster members as used
  for (const e of cluster) used.add(e.id);
  result.merged += cluster.length;

  result.details.push(
    `  🔀 merged ${cluster.length} episodic entries into semantic: "${mergedContent.slice(0, 60)}..."`
  );

  if (!dryRun && semantic) {
    run.pendingWrites.push(semantic);
    result.semanticCreated++;

    // Demote source episodics (they've been compressed into neocortex):
    // scale half_life_days so they decay sooner while staying recoverable.
    // Immediate ranking is deliberately unchanged: the 2026-06-10 DAG
    // slice-1 eval measured that dropping children below a worse-retrieving
    // summary regresses budget-bounded QA (docs/evals/). The stored
    // strength is refreshed to the live value so inspect, replay sampling,
    // and strength-sorted assembly see the truth instead of a fake 0.3.
    // Mutate in place (not a copy): `cluster` holds the same object
    // references as `survivors`, and the later detectConflicts(survivors)
    // pass in this same run must see the post-demotion half-life, or it
    // can persist conflicts for entries the just-written state excludes.
    for (const e of cluster) {
      e.half_life_days = Math.max(1, Math.floor(e.half_life_days * MERGE_SOURCE_HALF_LIFE_FACTOR));
      e.strength = calculateStrength(e, run.now, run.decayOpts);
      run.pendingWrites.push(e);
    }
  }
  return true;
}

// mergeContents is DETERMINISTIC CONCATENATION (not an LLM paraphrase)
// — if a human rejected exactly this byte-identical rollup before, an
// unguarded sleep would regenerate it every cycle and
// batchWriteAndDelete's guard bypass (store.ts) would silently
// re-assert it forever. This producer-side check is what makes that
// bypass safe. A hit skips the WHOLE cluster: sources stay unmerged —
// not demoted, not deleted — so a later sleep gets another chance if
// the tombstone is lifted.
function mergeRejected(run: SleepRun, semantic: MemoryEntry, cluster: MemoryEntry[], related: MemoryEntry[], used: Set<string>): boolean {
  const consolidateDb = run.getConsolidateDb();
  if (!consolidateDb) return false;
  const newDigest = rejectionDigest(semantic.content);
  const oldDigest = rejectionDigest(legacyMergeContents(related)); // tombstones from older releases hold this format's digest
  const newHit = findRejectedValue(consolidateDb, semantic.tenantId, newDigest);
  const tombstone = newHit ?? findRejectedValue(consolidateDb, semantic.tenantId, oldDigest);
  const mergeDigest = newHit ? newDigest : oldDigest;
  if (!tombstone) return false;
  // Still mark used — these members are not re-tried against a
  // DIFFERENT cluster within this same pass; next sleep re-clusters
  // them fresh.
  const rejected = newHit ? cluster : related; // the old format digested the uncapped list, so rows past the cap were rejected too
  for (const e of rejected) used.add(e.id);
  try {
    appendAuditEvent(consolidateDb, {
      tenantId: semantic.tenantId,
      actor: 'sleep',
      op: 'reject_refusal',
      metadata: {
        digest: mergeDigest,
        reason: tombstone.reason,
        sourceIds: rejected.map((e) => e.id),
      },
    });
  } catch (error) {
    reportAuditWriteFailure('reject_refusal', String(error));
  }
  return true;
}

function flushPending(run: SleepRun, snapshot: Map<string, MemoryEntry>): void {
  const { result, pendingDeletes, pendingDormant } = run;
  result.removedIds = pendingDeletes;
  // One transaction; the snapshot keeps what the DAG passes and other writers changed while sleep ran.
  // Dormant moves ride in the same transaction (src/dormant.ts).
  if (run.dryRun) return;
  const left = new Set(batchWriteAndDelete(run.hippoRoot, run.pendingWrites, pendingDeletes, { snapshot, dormant: pendingDormant }));
  for (const id of [...pendingDeletes, ...pendingDormant.map((m) => m.entry.id)]) {
    if (!left.has(id)) result.details.push(`  ↩  ${id} not removed: pinned or already gone before sleep saved`);
  }
  result.removedIds = pendingDeletes.filter((id) => left.has(id));
  result.removed = result.removedIds.length;
  result.dormant = pendingDormant.filter((m) => left.has(m.entry.id)).length;
}

// Dormant retention: a dormant memory nobody restored within
// dormant.retentionDays is deleted for good (0 keeps them forever). Runs
// even when dormant.enabled is off, so turning it off still ages out what
// earlier sleeps kept.
function expireDormant(run: SleepRun): void {
  const { config, result, dryRun } = run;
  if (!(config.dormant.retentionDays > 0)) return;
  const cutoff = new Date(run.now.getTime() - config.dormant.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const db = openHippoDb(run.hippoRoot);
  try {
    result.dormantExpired = dryRun ? countExpiredDormant(db, cutoff) : purgeExpiredDormant(db, cutoff);
  } finally {
    closeHippoDb(db);
  }
  if (result.dormantExpired > 0) {
    result.details.push(`  ⌛ ${dryRun ? 'would expire' : 'expired'} ${result.dormantExpired} dormant memor${result.dormantExpired === 1 ? 'y' : 'ies'} older than ${config.dormant.retentionDays} days`);
  }
}

// -------------------------------------------------------------------------
// 4. Log run
// -------------------------------------------------------------------------
function logRun(run: SleepRun, decay: DecayOutcome): void {
  const { hippoRoot, now, result } = run;
  const detectedConflicts = detectConflicts(run.survivors, now, run.decayOpts, decay.rescuedIds);
  replaceDetectedConflicts(hippoRoot, detectedConflicts, now.toISOString());

  if (detectedConflicts.length > 0) {
    result.details.push(`  ⚠️ detected ${detectedConflicts.length} memory conflict${detectedConflicts.length === 1 ? '' : 's'}`);
  }

  appendConsolidationRun(hippoRoot, {
    timestamp: now.toISOString(),
    decayed: result.decayed,
    merged: result.merged,
    removed: result.removed,
  });
  incrementSleepCount(hippoRoot);
  if (decay.rescuedEntries.length > 0) auditRescues(run, decay);
}

// One audit row per rescue (attributability, D1). Written here, AFTER
// batchWriteAndDelete has committed this cycle's writes/deletes
// (and after conflict detection + run logging), not inline in the decay
// pass — same durability posture as api.ts's top-level 'consolidate'
// summary audit row (written only once the whole sleep has completed).
// Writing it earlier would assert rescues for a cycle whose effects
// never landed if a later phase threw. Real writes only — dry-run
// previews the decision (details line above) but persists nothing.
function auditRescues(run: SleepRun, { rescuedEntries, rankById }: DecayOutcome): void {
  const { result } = run;
  try {
    const auditDb = openHippoDb(run.hippoRoot);
    try {
      // Review-round F5: per-row try/catch, not one try/catch around the
      // whole loop — a single failed appendAuditEvent must not silently
      // drop every remaining row. Mirrors the physics pass's
      // skipped-warning precedent: count losses, keep
      // the overall fail-soft posture, tell the operator via details.
      let auditFailures = 0;
      for (const entry of rescuedEntries) {
        try {
          const rank = rankById.get(entry.id);
          appendAuditEvent(auditDb, {
            tenantId: entry.tenantId,
            actor: 'sleep',
            op: 'mv_rescue',
            targetId: entry.id,
            metadata: rank
              ? { rank: rank.rank, totalNonPinned: rank.totalNonPinned, keepN: rank.keepN, score: rank.score }
              : {},
          });
        } catch (error) {
          auditFailures++;
          reportAuditWriteFailure('mv_rescue', String(error), entry.id);
        }
      }
      if (auditFailures > 0) {
        result.details.push(
          `  ⚠️ memory-value: ${auditFailures} mv_rescue audit row${auditFailures === 1 ? '' : 's'} ` +
          `failed to write (the rescue itself still landed)`,
        );
      }
    } finally {
      closeHippoDb(auditDb);
    }
  } catch {
    // openHippoDb/closeHippoDb-level failure: audit must never crash a
    // mutation (mirrors store.ts's audit() posture).
    result.details.push(
      `  ⚠️ memory-value: mv_rescue audit unavailable this cycle ` +
      `(${rescuedEntries.length} rescue${rescuedEntries.length === 1 ? '' : 's'} not audited)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeContents(entries: MemoryEntry[]): string {
  // Each distinct text goes in once and in full (the merge demotes every source), one bullet with its lines indented, so heldTextKeys can read it back.
  // Newest first says which version is current; compareEntryIdentity settles ties, so the row and its rejection digest depend only on the sources.
  const sorted = [...entries].sort((a, b) => (Date.parse(b.created) - Date.parse(a.created)) || compareEntryIdentity(a, b));
  const texts = new Map<string, string>();
  for (const e of sorted) {
    if (!texts.has(duplicateKey(e.content))) texts.set(duplicateKey(e.content), e.content);
  }
  const header = entries.length === 2 ? '[Consolidated from 2 related memories, newest first]' : `[Consolidated pattern from ${entries.length} related memories, newest first]`;
  return mergedText(header, [...texts.values()]);
}

function legacyMergeContents(entries: MemoryEntry[]): string {
  // The old format dropped text, so it is only ever digested to match rejections recorded against it, never written.
  const sorted = [...entries].sort((a, b) => (b.content.length - a.content.length) || compareEntryIdentity(a, b));
  if (entries.length === 2) return `[Consolidated from ${entries.length} related memories]\n\n${sorted[0].content}`;
  const bullets = sorted.map((e) => `- ${e.content.split('\n')[0].slice(0, 120)}`).join('\n');
  return `[Consolidated pattern from ${entries.length} related memories]\n\n${bullets}`;
}

function pickStrongestValence(entries: MemoryEntry[]): MemoryEntry['emotional_valence'] {
  const order = ['critical', 'negative', 'positive', 'neutral'] as const;
  for (const v of order) {
    if (entries.some((e) => e.emotional_valence === v)) return v;
  }
  return 'neutral';
}

/** Maps i to each j > i, ascending, whose text overlap with i reaches the merge threshold; every text needs at least one token. */
export function mergePartners(contents: readonly string[]): (i: number) => number[] {
  const sets = contents.map((text) => new Set(tokenize(text)));
  const candidatesOf = overlapPartners(sets, jaccardMinShared(MERGE_OVERLAP_THRESHOLD));
  return (i) => candidatesOf(i).filter((j) => jaccardSets(sets[i], sets[j]) >= MERGE_OVERLAP_THRESHOLD);
}

/** Pairs of live non-semantic memories that contradict each other, in survivor order. */
export function detectConflicts(
  entries: MemoryEntry[],
  now: Date,
  decayOpts: DecayOptions = {},
  // LC2-E3 (opt-in, default off): ids rescued by this cycle's decay pass.
  // detectConflicts recomputes its own strength>=DECAY_THRESHOLD survivor
  // filter independently of the decay pass above; without this bypass,
  // rescued entries would be silently re-excluded from conflict detection
  // every cycle even though the decay pass just decided to keep them.
  // Default empty set: flag-off behavior is unchanged.
  rescuedIds: Set<string> = new Set(),
): Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> {
  const survivors = entries.filter(
    (entry) =>
      entry.layer !== Layer.Semantic
      // CD5: an unreviewed quarantined row must not taint a visible memory as conflicted.
      && !isQuarantineScope(entry.scope ?? null)
      && (rescuedIds.has(entry.id) || calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD),
  );
  const detected: Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> = [];
  const profiles = survivors.map((entry) => conflictProfile(entry.content));
  const partnersOf = overlapPartners(
    profiles.map((p) => p.distinct),
    jaccardMinShared(CONFLICT_OVERLAP_THRESHOLD, CONFLICT_MIN_RARE_SHARED),
  );

  for (let i = 0; i < survivors.length; i++) {
    for (const j of partnersOf(i)) {
      // Traces are variants of each other, not contradictions. Two
      // strategies for the same task can both be valid; conflict detection
      // exists for stated-rule disagreement, not strategy diversity.
      if (survivors[i].layer === Layer.Trace && survivors[j].layer === Layer.Trace) continue;
      if (survivors[i].superseded_by || survivors[j].superseded_by) continue;
      if (!recalledTogether(survivors[i], survivors[j])) continue;
      if ([survivors[i], survivors[j]].some((e) => e.tags.includes('extracted') || e.tags.includes('session-digest'))) continue;
      const reasonAndScore = describeConflict(profiles[i], profiles[j]);
      if (!reasonAndScore) continue;
      detected.push({
        memory_a_id: survivors[i].id,
        memory_b_id: survivors[j].id,
        reason: reasonAndScore.reason,
        score: reasonAndScore.score,
      });
    }
  }

  return detected;
}

/** One project's ambient context can show both: same tenant, and the same project or a user-global row beside a project's. */
function recalledTogether(a: MemoryEntry, b: MemoryEntry): boolean {
  if (a.tenantId !== b.tenantId) return false;
  const [x, y] = [a.origin_project ?? null, b.origin_project ?? null];
  return x === y || (x === '' && y !== null) || (y === '' && x !== null);
}

type ConflictPolarity = 'positive' | 'negative' | 'neutral';

interface ConflictProfile {
  readonly distinct: Set<string>;
  readonly polarity: ConflictPolarity;
  /** Lowercased opening window padded with spaces, as classifyConflictType matches it. */
  readonly window: string;
}

function conflictProfile(text: string): ConflictProfile {
  const opening = openingWindow(text);
  // Polarity is measured only in the first POLARITY_WINDOW_WORDS, so a stray
  // negation deep in a prose memory doesn't flip the intent.
  // Pad with spaces so space-delimited patterns match words at the start/end.
  return { distinct: distinctiveTokens(text), polarity: inferConflictPolarity(opening), window: ' ' + opening.toLowerCase() + ' ' };
}

function describeConflict(a: ConflictProfile, b: ConflictProfile): { reason: string; score: number } | null {
  // Jaccard on stopword-stripped tokens. Defer the threshold check until we
  // know whether an explicit polarity pair is present (lower bar for those).
  const overlapScore = jaccardSets(a.distinct, b.distinct);

  // Require at least N shared distinctive tokens so two short memories sharing
  // only "the project name" don't register.
  let shared = 0;
  for (const t of a.distinct) if (b.distinct.has(t)) shared++;
  if (shared < CONFLICT_MIN_RARE_SHARED) return null;

  const conflictType = classifyConflictType(a.window, b.window, a.polarity, b.polarity);
  if (!conflictType) return null;

  if (overlapScore < CONFLICT_OVERLAP_THRESHOLD) return null;

  return {
    reason: conflictType,
    score: overlapScore,
  };
}

function distinctiveTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !CONFLICT_STOPWORDS.has(t)),
  );
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function openingWindow(text: string): string {
  return text.split(/\s+/).slice(0, POLARITY_WINDOW_WORDS).join(' ');
}

// Takes opening windows only, so " on " and " off " as prepositions deep in long prose don't read as enabled/disabled.
function classifyConflictType(
  a: string,
  b: string,
  aPolarity: ConflictPolarity,
  bPolarity: ConflictPolarity,
): string | null {
  // Tightened tokens: require whole-word boundaries so " on " alone doesn't
  // match "on/off". Pair only `enabled` ↔ `disabled` and explicit on/off in
  // imperative context.
  const enabledDisabled =
    (containsAny(a, [' enabled ', ' enable ']) && containsAny(b, [' disabled ', ' disable ']))
    || (containsAny(b, [' enabled ', ' enable ']) && containsAny(a, [' disabled ', ' disable ']));
  if (enabledDisabled) return 'enabled/disabled mismatch on overlapping statement';

  const trueFalse = (containsAny(a, [' true ', ' true.', ' true,', ' yes ']) && containsAny(b, [' false ', ' false.', ' false,', ' no ']))
    || (containsAny(b, [' true ', ' true.', ' true,', ' yes ']) && containsAny(a, [' false ', ' false.', ' false,', ' no ']));
  if (trueFalse) return 'true/false mismatch on overlapping statement';

  const alwaysNever = (containsAny(a, [' always ', ' must ']) && containsAny(b, [' never ', ' must not ']))
    || (containsAny(b, [' always ', ' must ']) && containsAny(a, [' never ', ' must not ']));
  if (alwaysNever) return 'always/never mismatch on overlapping statement';

  if ((aPolarity === 'positive' && bPolarity === 'negative') || (aPolarity === 'negative' && bPolarity === 'positive')) {
    return 'negation polarity mismatch on overlapping statement';
  }

  return null;
}

function inferConflictPolarity(text: string): ConflictPolarity {
  const lowered = ` ${text.toLowerCase()} `;
  const negativePatterns = [
    ' not ', ' never ', ' no ', " don't ", ' do not ', " doesn't ", ' does not ',
    " can't ", ' cannot ', " shouldn't ", ' should not ', ' disabled ', ' disable ', ' off ',
    ' false ', ' missing ', ' broken ', ' failed ',
  ];
  const positivePatterns = [
    ' enabled ', ' enable ', ' works ', ' working ', ' true ', ' available ', ' present ', ' on ',
    ' always ', ' must ',
  ];

  if (containsAny(lowered, negativePatterns)) return 'negative';
  if (containsAny(lowered, positivePatterns)) return 'positive';
  return 'neutral';
}

function stripConflictPolarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b(?:not|never|no|don['’]?t|do\s+not|doesn['’]?t|does\s+not|can['’]?t|cannot|shouldn['’]?t|should\s+not|enabled|enable|disabled|disable|on|off|true|false|always|must|must\s+not|works?|working|missing|broken|failed|available|present)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

