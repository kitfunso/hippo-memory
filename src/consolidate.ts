/**
 * Consolidation engine ("Sleep") for Hippo.
 *
 * Steps:
 * 1. Decay pass  - remove entries below strength threshold
 * 2. Merge pass  - find episodic entries with high text overlap, create semantic summaries
 * 3. Stats tracking
 */

import { evalNow, isRecallBoostAblated } from './ablation.js';
import { MemoryEntry, Layer, calculateStrength, createMemory, resolveConfidence, type DecayOptions } from './memory.js';
import {
  loadAllEntries,
  writeEntry,
  deleteEntry,
  batchWriteAndDelete,
  appendConsolidationRun,
  replaceDetectedConflicts,
  loadSessionDecayContext,
  incrementSleepCount,
  findPromotableSessions,
  traceExistsForSession,
  listSessionEvents,
} from './store.js';
import { textOverlap, markRetrieved } from './search.js';
import { compareEntryIdentity } from './compare.js';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from './db.js';
import { rejectionDigest, findRejectedValue } from './rejection.js';
import { loadPhysicsState, savePhysicsState, refreshParticleProperties } from './physics-state.js';
import { simulate, type ForceContext } from './physics.js';
import { loadConfig } from './config.js';
import { sampleForReplay } from './replay.js';
import { renderTraceContent } from './trace.js';
import { resolveTenantId } from './tenant.js';
import { rescueSet, rankNonPinnedByTenant, validateWeights, type MvRankInfo } from './memory-value.js';
import { MEMORY_VALUE_WEIGHTS, SOURCE_ARTIFACT_SHA256 } from './memory-value-weights.js';
import { appendAuditEvent } from './audit.js';

const DECAY_THRESHOLD = 0.05;
const MERGE_OVERLAP_THRESHOLD = 0.35;  // Jaccard similarity for "related"
const MERGE_MIN_CLUSTER = 2;            // minimum cluster size to merge
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
  merged: number;
  semanticCreated: number;
  replayed: number;
  promotedTraces: number;
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
}

const REPLAY_COUNT_DEFAULT = 5;

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
  options: { dryRun?: boolean; now?: Date } = {}
): Promise<ConsolidationResult> {
  const now = options.now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const dryRun = options.dryRun ?? false;

  const result: ConsolidationResult = {
    decayed: 0,
    removed: 0,
    merged: 0,
    semanticCreated: 0,
    replayed: 0,
    promotedTraces: 0,
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

  // L9: host-wide by design. Consolidation runs across all tenants in one
  // pass — per-tenant filtering would create N consolidation runs per host
  // with no cross-tenant dedup. The api.sleep audit row tags this with the
  // admin synthetic actor; see api.ts:2050 for the rationale.
  const all = loadAllEntries(hippoRoot);

  // Load decay options from config + session context
  const config = loadConfig(hippoRoot);
  const sessionCtx = loadSessionDecayContext(hippoRoot);
  const decayOpts: DecayOptions = {
    decayBasis: config.decayBasis,
    avgSessionIntervalDays: sessionCtx.avgSessionIntervalDays,
    sleepCount: sessionCtx.sleepCount,
  };

  // Collect all writes/deletes and batch them at the end
  const pendingWrites: MemoryEntry[] = [];
  const pendingDeletes: string[] = [];

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
  const survivors: MemoryEntry[] = [];
  let rescuedIds: Set<string> = new Set();
  // Carried forward to the post-flush "4. Log run" section below, where the
  // mv_rescue audit rows are actually written (code-review fix: writing them
  // here, before batchWriteAndDelete, would assert rescues for a cycle whose
  // effects might never land if a later phase throws).
  let rescuedEntries: MemoryEntry[] = [];
  let rankById: Map<string, MvRankInfo> = new Map();
  if (config.memoryValue.enabled) {
    // --- Phase 1: classify (zero commits) ---
    const condemned: MemoryEntry[] = [];
    const strengthById = new Map<string, number>();
    for (const entry of all) {
      const strength = calculateStrength(entry, now, decayOpts);
      strengthById.set(entry.id, strength);
      if (!entry.pinned && strength < DECAY_THRESHOLD) {
        condemned.push(entry);
      }
    }

    // --- Phase 2a: rescue decision (pure compute) ---
    // Runs under --dry-run too (only pendingDeletes/the audit write in
    // "4. Log run" below stay !dryRun-gated), so the preview matches what a
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

      // Review-round F2: entries with a non-finite computed feature (e.g. a
      // malformed `created` string -> Date.parse NaN) score -Infinity in
      // rankById and rescueSet's explicit finite-score guard means they can
      // never be rescued. Surfaced here as one details warning line naming
      // them, rather than leaving it a silent NaN-driven scoring detail.
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

    // --- Phase 2b: commit, one pass over `all` in ITS ORIGINAL ORDER ---
    // (review-round F4: rescued entries used to be appended at the tail of
    // survivors, systematically starving them in downstream order-sensitive
    // passes like extraction's slice(0,20) — a single pass over `all`
    // preserves flag-off's ordering semantics exactly.)
    for (const entry of all) {
      const strength = strengthById.get(entry.id)!;
      if (!entry.pinned && strength < DECAY_THRESHOLD) {
        if (rescuedIds.has(entry.id)) {
          // Rescued (D1): standard survivor bookkeeping refresh — same
          // stored-strength + effective-confidence update every other
          // survivor gets (round-2 code-review P2-1). D1's "kept as-is"
          // protects against half-life edits and rank-derived writes, not
          // against the ordinary decay-pass refresh every survivor
          // receives; leaving a rescued entry's stale strength (e.g. 1.0)
          // on disk would mislead downstream replay/admission reads.
          const effectiveConfidence = resolveConfidence(entry, now);
          const updated = { ...entry, strength, confidence: effectiveConfidence };
          survivors.push(updated);
          if (!dryRun && (strength !== entry.strength || effectiveConfidence !== entry.confidence)) {
            pendingWrites.push(updated);
          }
          result.decayed++;
          rescuedEntries.push(updated);
          const rank = rankById.get(entry.id);
          const rankNote = rank
            ? ` - rescued (rank ${rank.rank}/${rank.totalNonPinned} in tenant ${rank.tenantId}, top ${rank.keepN})`
            : ' - rescued';
          result.details.push(`  🛟 ${entry.id} (strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})${rankNote}`);
        } else {
          result.removed++;
          result.details.push(`  🗑  removed ${entry.id} (strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})`);
          if (!dryRun) {
            pendingDeletes.push(entry.id);
          }
        }
      } else {
        const effectiveConfidence = resolveConfidence(entry, now);
        const updated = { ...entry, strength, confidence: effectiveConfidence };
        survivors.push(updated);
        if (!dryRun && (strength !== entry.strength || effectiveConfidence !== entry.confidence)) {
          pendingWrites.push(updated);
        }
        result.decayed++;
      }
    }
  } else {
    for (const entry of all) {
      const strength = calculateStrength(entry, now, decayOpts);

      if (!entry.pinned && strength < DECAY_THRESHOLD) {
        result.removed++;
        result.details.push(`  🗑  removed ${entry.id} (strength ${strength.toFixed(4)} < ${DECAY_THRESHOLD})`);
        if (!dryRun) {
          pendingDeletes.push(entry.id);
        }
      } else {
        // Update the stored strength value and persist stale confidence when applicable.
        const effectiveConfidence = resolveConfidence(entry, now);
        const updated = {
          ...entry,
          strength,
          confidence: effectiveConfidence,
        };
        survivors.push(updated);
        if (!dryRun && (strength !== entry.strength || effectiveConfidence !== entry.confidence)) {
          pendingWrites.push(updated);
        }
        result.decayed++;
      }
    }
  }

  // AT1 rejection-guard db handle (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
  // covers BOTH the auto-promote pass (1.4, immediately below) and the merge
  // pass (3, further down) — both build deterministic content that
  // batchWriteAndDelete writes through the guard's bypass, so both need a
  // producer-side tombstone check before pushing to pendingWrites.
  //
  // T3 fix (2026-08-15 hardening pass, perf hygiene): memoized lazy getter,
  // not an eager open. The handle only serves these two tombstone checks —
  // a sleep with zero promotable sessions and zero merge clusters never
  // reaches either use site, so opening it unconditionally on every
  // non-dry-run sleep paid a db-open cost for nothing. dryRun still never
  // opens (getConsolidateDb short-circuits before touching the handle).
  // Every `if (consolidateDb)` guard below becomes `const consolidateDb =
  // getConsolidateDb();` at its use site — same semantics, opened on first
  // real use. consolidateDbOpened (not just a truthy handle check) is the
  // single source of truth for "was this ever opened", so the finally below
  // closes it exactly once and never double-opens.
  //
  // AT1 P2 fix (codex, handle-leak restructure): the getter's lifetime must
  // start IMMEDIATELY before the try whose finally closes it, covering every
  // phase that can touch it — not just the merge pass. Previously the
  // try/finally wrapped only section 3 (merge pass); an exception thrown by
  // auto-promote (1.4), replay (1.5), batch extraction (1.6), the DAG
  // passes (1.7-1.9), or physics (2) would propagate past an open handle
  // with nothing to close it. No behavior change on the happy path — each
  // of those phases already best-effort catches its own exceptions today
  // (physics has its own try/catch below; each DAG pass wraps its own
  // dynamic import + call in try/catch) — this only closes the handle on
  // the rare path where one of them throws past its own catch. Deliberately
  // NOT re-indented (mechanical wrap only, kept surgical): every statement
  // between this try and its finally (below, at the end of the merge pass)
  // stays at its original indentation.
  let consolidateDbHandle: DatabaseSyncLike | null = null;
  let consolidateDbOpened = false;
  const getConsolidateDb = (): DatabaseSyncLike | null => {
    if (dryRun) return null;
    if (!consolidateDbOpened) {
      consolidateDbHandle = openHippoDb(hippoRoot);
      consolidateDbOpened = true;
    }
    return consolidateDbHandle;
  };
  // Declared here (not at the merge pass, its point of use) so it survives
  // this try/finally — a `let` declared INSIDE the try would go out of
  // scope before the `if (mergesSkippedRejected > 0)` check that reads it
  // after the finally closes the handle.
  let mergesSkippedRejected = 0;
  try {

  // -------------------------------------------------------------------------
  // 1.4. Auto-promote complete sessions to traces
  // -------------------------------------------------------------------------
  //
  // For each session within the configured window that has a `session_complete`
  // event and no existing trace (idempotency via the source_session_id column),
  // render the action sequence as markdown and persist a Layer.Trace memory.
  // Traces inherit decay, search, replay, and physics from the base MemoryEntry.
  if (!dryRun && config.autoTraceCapture !== false) {
    let tracesSkippedRejected = 0;
    const windowDays = config.autoTraceWindowDays ?? 7;
    const sinceMs = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
    // Auto-trace currently runs in a single-tenant context (the env-resolved
    // tenant for this process). Multi-tenant deployments that want
    // consolidation across all tenants need a per-tenant loop layered on top
    // of this — tracked in docs/plans/2026-05-02-continuity-tables-tenant-scope.md.
    const consolidationTenant = resolveTenantId({});
    const promotable = findPromotableSessions(hippoRoot, consolidationTenant, sinceMs);

    for (const session of promotable) {
      // Idempotency: skip if a trace for this session already exists.
      if (traceExistsForSession(hippoRoot, consolidationTenant, session.session_id)) continue;

      const events = listSessionEvents(hippoRoot, consolidationTenant, {
        session_id: session.session_id,
        limit: 1000,
      });
      const completeEvent = events.find((e) => e.event_type === 'session_complete');
      if (!completeEvent) continue; // defence-in-depth; findPromotableSessions filters already.

      const outcomeRaw = completeEvent.content;
      if (outcomeRaw !== 'success' && outcomeRaw !== 'failure' && outcomeRaw !== 'partial') {
        // Malformed terminal event — skip rather than crash the whole sleep.
        continue;
      }
      const outcome: 'success' | 'failure' | 'partial' = outcomeRaw;

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
          source_session_id: session.session_id,
          tags: ['auto-promoted'],
          source: 'auto-promote',
          // T1 fix (2026-08-15 hardening pass): stamp the trace into the SAME
          // tenant the traceExistsForSession idempotency check (above) runs
          // under. Before
          // this, createMemory omitted tenantId and the trace always landed
          // 'default' (memory.ts:535) while the idempotency check ran under
          // consolidationTenant — for any non-default tenant that check never
          // hit, and the trace regenerated every sleep.
          tenantId: consolidationTenant,
        },
      );

      // AT1 (same producer-side pattern as the merge pass below): traceExistsForSession
      // only sees rows CURRENTLY in the store — once a rejected trace is
      // removed, that idempotency check no longer blocks regeneration, and
      // this write would otherwise reach batchWriteAndDelete's guard bypass
      // unchecked, resurrecting it every sleep. Check under THE ENTRY'S OWN
      // stamped tenantId (read off `trace` after createMemory — never guess
      // the tenant) + the built content's digest. A hit skips the push
      // entirely: not counted as promoted, not added to survivors.
      const consolidateDb = getConsolidateDb();
      if (consolidateDb) {
        const traceDigest = rejectionDigest(trace.content);
        const tombstone = findRejectedValue(consolidateDb, trace.tenantId, traceDigest);
        if (tombstone) {
          tracesSkippedRejected++;
          try {
            appendAuditEvent(consolidateDb, {
              tenantId: trace.tenantId,
              actor: 'sleep',
              op: 'reject_refusal',
              metadata: {
                digest: traceDigest,
                reason: tombstone.reason,
                sourceSessionId: session.session_id,
              },
            });
          } catch {
            // Best-effort — mirrors store.ts's audit() semantics.
          }
          continue;
        }
      }

      pendingWrites.push(trace);
      survivors.push(trace);
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
      console.error(
        `consolidate: skipped ${tracesSkippedRejected} auto-promoted trace(s) whose content matches a rejected value`,
      );
    }
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
  {
    const replayCount = config.replay?.count ?? REPLAY_COUNT_DEFAULT;
    // EVAL-ONLY ablation (see ablation.ts): replay rehearsal IS recall
    // strengthening (same markRetrieved dynamics), so the strengthen-off arm
    // silences the whole pass - markRetrieved would return unmutated entries
    // and persisting them anyway would still refresh updated_at / mirrors.
    if (replayCount > 0 && survivors.length > 0 && !isRecallBoostAblated()) {
      const seed = Math.floor(now.getTime() / 1000) & 0xffffffff;
      const picked = sampleForReplay(survivors, replayCount, now, seed);
      if (picked.length > 0) {
        const rehearsed = markRetrieved(picked, now);
        const rehearsedById = new Map(rehearsed.map((e) => [e.id, e]));
        // Update survivors in place so downstream passes see rehearsed state.
        for (let i = 0; i < survivors.length; i++) {
          const replacement = rehearsedById.get(survivors[i].id);
          if (replacement) survivors[i] = replacement;
        }
        result.replayed = rehearsed.length;
        result.details.push(
          `  💭 replayed ${rehearsed.length} memor${rehearsed.length === 1 ? 'y' : 'ies'}: ` +
          rehearsed.map((e) => e.id).join(', ')
        );
        if (!dryRun) {
          for (const r of rehearsed) pendingWrites.push(r);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 1.6. Batch extraction — extract facts from episodic memories missing them
  // -------------------------------------------------------------------------
  const extractedFromIds = new Set(
    survivors.filter((e) => e.extracted_from).map((e) => e.extracted_from!),
  );
  const extractionCandidates = survivors.filter(
    (e) => e.layer === Layer.Episodic && !extractedFromIds.has(e.id),
  );
  result.extractionCandidates = extractionCandidates.length;

  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (apiKey && extractionCandidates.length > 0 && !dryRun) {
    const { extractFacts, storeExtractedFacts } = await import('./extract.js');
    const batchLimit = 20;
    let extractedCount = 0;
    for (const candidate of extractionCandidates.slice(0, batchLimit)) {
      try {
        const facts = await extractFacts(candidate.content, {
          apiKey,
          model: config.extraction.model,
        });
        if (facts.length > 0) {
          storeExtractedFacts(hippoRoot, candidate, facts);
          extractedCount += facts.length;
        }
      } catch {
        // Best-effort — continue with next candidate
      }
    }
    result.extracted = extractedCount;
  }

  // -------------------------------------------------------------------------
  // 1.7. DAG summarization — cluster extracted facts and generate summaries
  // -------------------------------------------------------------------------
  const extractedFacts = survivors.filter(
    (e) => e.tags.includes('extracted') && e.dag_level === 1,
  );
  if (apiKey && extractedFacts.length >= 3 && !dryRun) {
    try {
      const { buildDag } = await import('./dag.js');
      const dagResult = await buildDag(hippoRoot, extractedFacts, {
        apiKey,
        model: config.extraction.model,
      });
      result.dagCandidateClusters = dagResult.candidateClusters;
      result.dagSummariesCreated = dagResult.summariesCreated;
      if (dagResult.summariesCreated > 0) {
        result.details.push(`  🌳 DAG: ${dagResult.summariesCreated} summaries created, ${dagResult.factsLinked} facts linked`);
      }
    } catch {
      // Best-effort
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
  if (apiKey && !dryRun) {
    try {
      const { rebuildDirtySummaries } = await import('./dag.js');
      const rawCap = parseInt(process.env.HIPPO_DAG_REBUILD_CAP ?? '20', 10);
      // R1 MED must-fix: hard ceiling so misconfigured env can't burn
      // unbounded LLM cost.
      const cap = Number.isFinite(rawCap) && rawCap > 0
        ? Math.min(rawCap, 1000)
        : 20;
      const rebuildResult = await rebuildDirtySummaries(hippoRoot, {
        apiKey,
        model: config.extraction.model,
        cap,
      });
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
    } catch {
      // Best-effort — same posture as buildDag block above.
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
  if (apiKey && !dryRun) {
    try {
      const { buildEntityProfiles } = await import('./dag.js');
      const { loadAllL2Summaries } = await import('./store.js');
      const l2Summaries = loadAllL2Summaries(hippoRoot);
      if (l2Summaries.length >= 2) {
        const profileResult = await buildEntityProfiles(hippoRoot, l2Summaries, {
          apiKey,
          model: config.extraction.model,
        });
        result.entityProfilesCreated = profileResult.profilesCreated;
        if (profileResult.profilesCreated > 0) {
          result.details.push(`  🌲 DAG L3: ${profileResult.profilesCreated} entity profiles, ${profileResult.l2sLinked} L2s linked`);
        }
      }
    } catch {
      // Best-effort.
    }
  }

  // -------------------------------------------------------------------------
  // 2. Physics simulation pass
  // -------------------------------------------------------------------------
  if (!dryRun) {
    try {
      const physicsEnabled = config.physics.enabled === true
        || (config.physics.enabled === 'auto');

      if (physicsEnabled) {
        const db = openHippoDb(hippoRoot);
        try {
          const physicsMap = loadPhysicsState(db);
          const particles = Array.from(physicsMap.values());

          if (particles.length > 0) {
            // Build entry lookup for property refresh
            const entryMap = new Map(survivors.map(e => [e.id, e]));
            refreshParticleProperties(particles, entryMap, now);

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

  // -------------------------------------------------------------------------
  // 3. Merge pass  - episodic entries only
  // -------------------------------------------------------------------------
  const mergeCandidates = survivors.filter(
    (e) => e.layer === Layer.Episodic && !e.tags.includes('extracted'),
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
    const bucket = mergeCandidatesByTenant.get(entry.tenantId);
    if (bucket) bucket.push(entry);
    else mergeCandidatesByTenant.set(entry.tenantId, [entry]);
  }

  // AT1 consolidation-loop fix (docs/plans/2026-08-15-at1-rejected-value-tombstone.md):
  // reuses the single consolidateDb handle opened once above (before the
  // auto-promote pass, 1.4) for the whole non-dry-run consolidate — see that
  // declaration's comment. Only needed for real writes — a dry-run preview
  // never reaches batchWriteAndDelete's guard bypass, so there is nothing
  // here for it to protect against. (mergesSkippedRejected itself is
  // declared up at the try's opening above 1.4, not here — it has to
  // survive the try/finally that now wraps this whole section; see the
  // handle-leak restructure comment there.)
  for (const [mergeTenant, tenantCandidates] of mergeCandidatesByTenant) {
    for (let i = 0; i < tenantCandidates.length; i++) {
      if (used.has(tenantCandidates[i].id)) continue;

      const cluster: MemoryEntry[] = [tenantCandidates[i]];

      for (let j = i + 1; j < tenantCandidates.length; j++) {
        if (used.has(tenantCandidates[j].id)) continue;
        const overlap = textOverlap(tenantCandidates[i].content, tenantCandidates[j].content);
        if (overlap >= MERGE_OVERLAP_THRESHOLD) {
          cluster.push(tenantCandidates[j]);
        }
      }

      if (cluster.length < MERGE_MIN_CLUSTER) continue;

      // Create a semantic summary
      const mergedContent = mergeContents(cluster);
      const allTags = Array.from(new Set(cluster.flatMap((e) => e.tags)));
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
        semantic = createMemory(mergedContent, {
          layer: Layer.Semantic,
          tags: allTags,
          emotional_valence: maxValence,
          schema_fit: 0.7,
          source: 'consolidation',
          confidence: 'inferred',
          tenantId: mergeTenant,
        });
      }

      // mergeContents is DETERMINISTIC CONCATENATION (not an LLM paraphrase)
      // — if a human rejected exactly this byte-identical rollup before, an
      // unguarded sleep would regenerate it every cycle and
      // batchWriteAndDelete's guard bypass (store.ts) would silently
      // re-assert it forever. This producer-side check is what makes that
      // bypass safe. A hit skips the WHOLE cluster: sources stay unmerged —
      // not demoted, not deleted — so a later sleep gets another chance if
      // the tombstone is lifted.
      const consolidateDb = getConsolidateDb();
      if (consolidateDb && semantic) {
        const mergeDigest = rejectionDigest(semantic.content);
        const tombstone = findRejectedValue(consolidateDb, semantic.tenantId, mergeDigest);
        if (tombstone) {
          // Still mark used — these members are not re-tried against a
          // DIFFERENT cluster within this same pass; next sleep re-clusters
          // them fresh.
          for (const e of cluster) used.add(e.id);
          mergesSkippedRejected++;
          try {
            appendAuditEvent(consolidateDb, {
              tenantId: semantic.tenantId,
              actor: 'sleep',
              op: 'reject_refusal',
              metadata: {
                digest: mergeDigest,
                reason: tombstone.reason,
                sourceIds: cluster.map((e) => e.id),
              },
            });
          } catch {
            // Best-effort — mirrors store.ts's audit() semantics.
          }
          continue;
        }
      }

      // Mark cluster members as used
      for (const e of cluster) used.add(e.id);
      result.merged += cluster.length;

      result.details.push(
        `  🔀 merged ${cluster.length} episodic entries into semantic: "${mergedContent.slice(0, 60)}..."`
      );

      if (!dryRun && semantic) {
        pendingWrites.push(semantic);
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
          e.strength = calculateStrength(e, now, decayOpts);
          pendingWrites.push(e);
        }
      }
    }
  }
  } finally {
    if (consolidateDbHandle) closeHippoDb(consolidateDbHandle);
  }

  if (mergesSkippedRejected > 0) {
    console.error(
      `consolidate: skipped ${mergesSkippedRejected} merge(s) whose content matches a rejected value`,
    );
  }

  // Flush all writes/deletes in a single transaction
  if (!dryRun) {
    batchWriteAndDelete(hippoRoot, pendingWrites, pendingDeletes);
  }

  // -------------------------------------------------------------------------
  // 4. Log run
  // -------------------------------------------------------------------------
  if (!dryRun) {
    const detectedConflicts = detectConflicts(survivors, now, decayOpts, rescuedIds);
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

    // One audit row per rescue (attributability, D1). Written here, AFTER
    // batchWriteAndDelete above has committed this cycle's writes/deletes
    // (and after conflict detection + run logging), not inline in the decay
    // pass — same durability posture as api.ts's top-level 'consolidate'
    // summary audit row (written only once the whole sleep has completed).
    // Writing it earlier would assert rescues for a cycle whose effects
    // never landed if a later phase threw. Real writes only — dry-run
    // previews the decision (details line above) but persists nothing.
    if (rescuedEntries.length > 0) {
      try {
        const auditDb = openHippoDb(hippoRoot);
        try {
          // Review-round F5: per-row try/catch, not one try/catch around the
          // whole loop — a single failed appendAuditEvent must not silently
          // drop every remaining row. Mirrors the physics pass's
          // skipped-warning precedent (line ~564 above): count losses, keep
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
            } catch {
              auditFailures++;
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
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mergeContents(entries: MemoryEntry[]): string {
  // Simple merge: take the longest entry as the base, prepend a summary note.
  // Equal-length merge bases previously fell to cluster-assembly order;
  // compareEntryIdentity is a deterministic tie key (content asc -> metadata -> id asc),
  // a no-op when lengths differ (docs/plans/2026-07-16-dedupe-survivor-determinism.md T2).
  const sorted = [...entries].sort((a, b) => (b.content.length - a.content.length) || compareEntryIdentity(a, b));
  const base = sorted[0].content;

  if (entries.length === 2) {
    return `[Consolidated from ${entries.length} related memories]\n\n${base}`;
  }

  // For 3+ entries, create a bulleted summary
  const bullets = entries.map((e) => `- ${e.content.split('\n')[0].slice(0, 120)}`).join('\n');
  return `[Consolidated pattern from ${entries.length} related memories]\n\n${bullets}`;
}

function pickStrongestValence(entries: MemoryEntry[]): MemoryEntry['emotional_valence'] {
  const order = ['critical', 'negative', 'positive', 'neutral'] as const;
  for (const v of order) {
    if (entries.some((e) => e.emotional_valence === v)) return v;
  }
  return 'neutral';
}

function detectConflicts(
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
      && (rescuedIds.has(entry.id) || calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD),
  );
  const detected: Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> = [];

  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      // Traces are variants of each other, not contradictions. Two
      // strategies for the same task can both be valid; conflict detection
      // exists for stated-rule disagreement, not strategy diversity.
      if (survivors[i].layer === Layer.Trace && survivors[j].layer === Layer.Trace) continue;
      if (survivors[i].superseded_by || survivors[j].superseded_by) continue;
      if (survivors[i].tags.includes('extracted') || survivors[j].tags.includes('extracted')) continue;
      const reasonAndScore = describeConflict(survivors[i], survivors[j]);
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

function describeConflict(a: MemoryEntry, b: MemoryEntry): { reason: string; score: number } | null {
  const aDistinct = distinctiveTokens(a.content);
  const bDistinct = distinctiveTokens(b.content);

  // Jaccard on stopword-stripped tokens. Defer the threshold check until we
  // know whether an explicit polarity pair is present (lower bar for those).
  const overlapScore = jaccardSets(aDistinct, bDistinct);

  // Require at least N shared distinctive tokens so two short memories sharing
  // only "the project name" don't register.
  let shared = 0;
  for (const t of aDistinct) if (bDistinct.has(t)) shared++;
  if (shared < CONFLICT_MIN_RARE_SHARED) return null;

  // Polarity is measured only in the first POLARITY_WINDOW_WORDS, so a stray
  // negation deep in a prose memory doesn't flip the intent.
  const polarityA = inferConflictPolarity(openingWindow(a.content));
  const polarityB = inferConflictPolarity(openingWindow(b.content));
  const conflictType = classifyConflictType(a.content, b.content, polarityA, polarityB);
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

function classifyConflictType(
  aText: string,
  bText: string,
  aPolarity: 'positive' | 'negative' | 'neutral',
  bPolarity: 'positive' | 'negative' | 'neutral',
): string | null {
  // Classifier scans only the opening window of each memory so " on " and
  // " off " used as English prepositions deep in a long prose memory don't
  // trigger an enabled/disabled flag. The opening window is where a rule or
  // declaration is typically stated.
  // Pad with spaces so space-delimited patterns match words at the start/end.
  const a = ' ' + openingWindow(aText).toLowerCase() + ' ';
  const b = ' ' + openingWindow(bText).toLowerCase() + ' ';

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

function inferConflictPolarity(text: string): 'positive' | 'negative' | 'neutral' {
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

