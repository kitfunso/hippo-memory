/**
 * Consolidation engine ("Sleep") for Hippo.
 *
 * Steps:
 * 1. Decay pass  - remove entries below strength threshold
 * 2. Merge pass  - find episodic entries with high text overlap, create semantic summaries
 * 3. Stats tracking
 */

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
  loadAllDirtySummaries,
} from './store.js';
import { textOverlap, markRetrieved } from './search.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { loadPhysicsState, savePhysicsState, refreshParticleProperties } from './physics-state.js';
import { simulate, type ForceContext } from './physics.js';
import { loadConfig } from './config.js';
import { sampleForReplay } from './replay.js';
import { renderTraceContent } from './trace.js';
import { resolveTenantId } from './tenant.js';

const DECAY_THRESHOLD = 0.05;
const MERGE_OVERLAP_THRESHOLD = 0.35;  // Jaccard similarity for "related"
const MERGE_MIN_CLUSTER = 2;            // minimum cluster size to merge
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
  summariesRebuildCapped: boolean;
  // v0.30 / E5 — L3 entity-profile build count
  entityProfilesCreated: number;
  dryRun: boolean;
  details: string[];
  physicsSimulated: number;
}

const REPLAY_COUNT_DEFAULT = 5;

/**
 * Run a full consolidation pass.
 */
export async function consolidate(
  hippoRoot: string,
  options: { dryRun?: boolean; now?: Date } = {}
): Promise<ConsolidationResult> {
  const now = options.now ?? new Date();
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
  const survivors: MemoryEntry[] = [];
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

  // -------------------------------------------------------------------------
  // 1.4. Auto-promote complete sessions to traces
  // -------------------------------------------------------------------------
  //
  // For each session within the configured window that has a `session_complete`
  // event and no existing trace (idempotency via the source_session_id column),
  // render the action sequence as markdown and persist a Layer.Trace memory.
  // Traces inherit decay, search, replay, and physics from the base MemoryEntry.
  if (!dryRun && config.autoTraceCapture !== false) {
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

      const summary = typeof completeEvent.metadata.summary === 'string'
        ? completeEvent.metadata.summary
        : '(untitled)';

      const trace = createMemory(
        renderTraceContent({ task: summary, steps, outcome }),
        {
          layer: Layer.Trace,
          trace_outcome: outcome,
          source_session_id: session.session_id,
          tags: ['auto-promoted'],
          source: 'auto-promote',
        },
      );
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
    if (replayCount > 0 && survivors.length > 0) {
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
  // each, atomically refreshes content + 6 metadata columns + clears
  // summary_dirty (with FTS sync). Cap HIPPO_DAG_REBUILD_CAP (default 20, hard
  // ceiling 1000) prevents runaway LLM cost.
  //
  // DAG slice 1 — NOT gated on apiKey anymore: rebuildDirtySummaries dispatches
  // on provenance, so a merge-built summary (source='consolidation') rebuilds
  // via the zero-dep compressor with NO LLM. Without this, a merge summary in a
  // key-less store would stay dirty forever after a child supersession (the
  // "graph that lies"). The LLM route still no-ops gracefully (fetch fails →
  // failed++) when a buildDag summary is dirty in a key-less store. When there
  // are no dirty summaries (the steady state, e.g. the hermetic eval), this is
  // a cheap no-op (loadAllDirtySummaries returns []).
  if (!dryRun) {
    try {
      const { rebuildDirtySummaries } = await import('./dag.js');
      const rawCap = parseInt(process.env.HIPPO_DAG_REBUILD_CAP ?? '20', 10);
      // R1 MED must-fix: hard ceiling so misconfigured env can't burn
      // unbounded LLM cost.
      const cap = Number.isFinite(rawCap) && rawCap > 0
        ? Math.min(rawCap, 1000)
        : 20;
      // DAG slice 1 — snapshot the dirty-summary ids BEFORE the rebuild.
      // rebuildDirtySummaries persists each rebuilt summary's row directly
      // (content + metadata) via applyRebuildResult. But the decay pass (phase
      // 1) may have captured a now-STALE copy of those same summary rows in
      // pendingWrites; the phase-3 batch flush would re-upsert that stale copy
      // and CLOBBER the rebuild (revert content, re-set summary_dirty). Drop the
      // rebuilt rows from pendingWrites so the authoritative rebuilt row stands.
      const dirtyBeforeRebuild = new Set(loadAllDirtySummaries(hippoRoot).map((s) => s.id));
      const rebuildResult = await rebuildDirtySummaries(hippoRoot, {
        apiKey,
        model: config.extraction.model,
        cap,
      });
      // Drop from pendingWrites BOTH the rebuilt summary rows AND the children
      // the rebuild detached (dag_parent_id -> null). The decay/replay pass may
      // have queued stale copies of either; re-upserting them would clobber the
      // rebuild (revert content / re-set summary_dirty) or UNDO the tombstone
      // detach (re-link a superseded child), making cleanup non-durable and
      // causing repeated rebuilds (codex P2).
      const rebuildWrittenIds = new Set(dirtyBeforeRebuild);
      for (const id of rebuildResult.detachedChildIds) rebuildWrittenIds.add(id);
      if (rebuildWrittenIds.size > 0) {
        for (let i = pendingWrites.length - 1; i >= 0; i--) {
          if (rebuildWrittenIds.has(pendingWrites[i].id)) pendingWrites.splice(i, 1);
        }
      }
      result.summariesRebuilt = rebuildResult.rebuilt;
      result.summariesRebuildFailed = rebuildResult.failed;
      result.summariesZeroChildSkipped = rebuildResult.zeroChildSkipped;
      result.summariesRebuildCapped = rebuildResult.capped;
      if (rebuildResult.rebuilt > 0 || rebuildResult.zeroChildSkipped > 0 || rebuildResult.failed > 0) {
        const parts: string[] = [];
        if (rebuildResult.rebuilt > 0) parts.push(`${rebuildResult.rebuilt} rebuilt`);
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
  // DAG slice 1 (codex P1): exclude episodics ALREADY linked to a summary
  // (dag_parent_id set). Without this, a 2nd+ sleep re-clusters already-merged
  // children into a NEW summary and re-links them, orphaning the prior summary
  // (stale descendant_count, zero children) - repeated consolidation would
  // corrupt the DAG instead of being idempotent.
  const mergeCandidates = survivors.filter(
    (e) =>
      e.layer === Layer.Episodic &&
      !e.tags.includes('extracted') &&
      !e.dag_parent_id &&
      !e.superseded_by, // superseded content must not form a new summary
  );
  const used = new Set<string>();

  for (let i = 0; i < mergeCandidates.length; i++) {
    if (used.has(mergeCandidates[i].id)) continue;

    const cluster: MemoryEntry[] = [mergeCandidates[i]];

    for (let j = i + 1; j < mergeCandidates.length; j++) {
      if (used.has(mergeCandidates[j].id)) continue;
      const overlap = textOverlap(mergeCandidates[i].content, mergeCandidates[j].content);
      if (overlap >= MERGE_OVERLAP_THRESHOLD) {
        cluster.push(mergeCandidates[j]);
      }
    }

    if (cluster.length < MERGE_MIN_CLUSTER) continue;

    // Mark cluster members as used
    for (const e of cluster) used.add(e.id);
    result.merged += cluster.length;

    // DAG slice 1: compress the cluster to boilerplate-free dense text strictly
    // smaller than the sum of the children (replaces the old non-compressing
    // mergeContents concat).
    const mergedContent = compressCluster(cluster);

    result.details.push(
      `  🔀 merged ${cluster.length} episodic entries into semantic: "${mergedContent.slice(0, 60)}..."`
    );

    if (!dryRun) {
      // DAG slice 1: emit the summary via the shared createDagSummaryNode helper
      // so it lands as a real L2 DAG node — dag_level=2, 'dag-summary' tag,
      // descendant_count + earliest/latest_at, child dag_parent_id links,
      // deterministic timestamps stamped from the children. The helper writes
      // the summary AND the child links immediately (DB-backed), so children
      // become retrievable via drillDown and substitutable under budget.
      //
      // source='consolidation' is the provenance rebuildDirtySummaries
      // dispatches on: a merge-built summary rebuilds via the zero-dep
      // compressor (no LLM), so the tombstone path works in a key-less store.
      const { createDagSummaryNode } = await import('./dag.js');
      const summary = createDagSummaryNode(hippoRoot, {
        content: mergedContent,
        children: cluster,
        source: 'consolidation',
      });
      result.semanticCreated++;

      // Keep the source episodics (do NOT delete, do NOT weaken). The inert
      // strength*0.3 write was removed: calculateStrength (memory.ts) never
      // reads the stored strength, so the weakening was a no-op that only
      // confused the eval. Children stay dag_level=0 and now carry
      // dag_parent_id = summary.id; mirror that link onto the in-memory
      // survivor objects so the deferred batchWriteAndDelete flush (which may
      // re-upsert these rows from the decay pass) preserves the link instead
      // of clobbering it back to null.
      for (const e of cluster) {
        e.dag_parent_id = summary.id;
        pendingWrites.push({ ...e, dag_parent_id: summary.id });
      }
    }
  }

  // Flush all writes/deletes in a single transaction
  if (!dryRun) {
    batchWriteAndDelete(hippoRoot, pendingWrites, pendingDeletes);
  }

  // -------------------------------------------------------------------------
  // 4. Log run
  // -------------------------------------------------------------------------
  if (!dryRun) {
    const detectedConflicts = detectConflicts(survivors, now, decayOpts);
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
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Zero-dep extractive compressor (DAG slice 1)
// ---------------------------------------------------------------------------
//
// Replaces the old non-compressing mergeContents concat. Collapses a cluster
// to the set of DISTINCT normalized informational lines/sentences:
//   - dedup unit = a normalized LINE/SENTENCE (NOT a token). Near-duplicate
//     paraphrases (same fact, different connective) collapse to one
//     representative; ALL distinct answer-bearing lines survive.
//   - boilerplate-free dense text. NO "[Consolidated from N...]" prefix (it
//     dilutes embedding similarity against the source content).
//   - strictly fewer tokens than the sum of the children (real margin), so the
//     summary can displace its children under a fixed budget.
//
// DETERMINISM: pure function of the input contents. No Date, no random, no
// Map-iteration-order dependence. Stable sort with a content tiebreak. Same
// inputs => byte-identical output.

const COMPRESS_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'and', 'or', 'as',
  'its', 'set', 'now', 'namely', 'equals', 'confirmed',
]);

// Two lines whose stopword-filtered token sets reach this Jaccard are treated
// as paraphrases of one another and collapse to a single representative. High
// enough that lines carrying DIFFERENT answer tokens (which differ in at least
// the token itself) stay distinct. SET-EQUALITY (1.0): codex P2 showed a long
// shared template differing only in a value token ("...is MONDAY..." vs
// "...is TUESDAY...") can exceed a fuzzy 0.7 and be wrongly dropped as a
// paraphrase, losing a distinct fact. Requiring IDENTICAL stopword-filtered
// token SETS guarantees only pure connective/stopword variation collapses
// ("X is ANS" == "X equals ANS"); any value-token difference is preserved.
const PARAPHRASE_JACCARD = 1.0;

/** Split content into candidate informational lines/sentences. */
function splitIntoLines(content: string): string[] {
  return content
    // sentence boundary: period/!/? followed by whitespace
    .split(/(?<=[.!?])\s+/)
    // also split on hard newlines and list bullets
    .flatMap((s) => s.split(/\n+/))
    .map((s) => s.replace(/^[-*•]\s*/, '').trim())
    .filter((s) => s.length > 0);
}

/** Stopword-filtered, lowercased token SET used as the paraphrase signature. */
function lineTokenSet(line: string): Set<string> {
  return new Set(
    line
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !COMPRESS_STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Compress a set of related contents to boilerplate-free dense text strictly
 * smaller (in estimated tokens) than the sum of the inputs. Exported so the
 * merge pass (createDagSummaryNode caller) and the rebuild path (dag.ts
 * provenance dispatch) share ONE implementation.
 */
export function compressContents(contents: string[]): string {
  // Collect every candidate line tagged with its source content length (for a
  // deterministic, info-favouring representative choice within a paraphrase
  // group: longer line wins, content tiebreak).
  const lines: string[] = [];
  for (const c of contents) {
    for (const l of splitIntoLines(c)) lines.push(l);
  }

  // Stable order: longest line first (most informational representative), then
  // lexical by content so equal-length lines never depend on input order.
  const sorted = [...lines].sort(
    (a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0),
  );

  // Greedy near-duplicate collapse against already-kept representatives.
  const keptLines: string[] = [];
  const keptSets: Set<string>[] = [];
  for (const line of sorted) {
    const sig = lineTokenSet(line);
    let isParaphrase = false;
    for (const kept of keptSets) {
      if (jaccard(sig, kept) >= PARAPHRASE_JACCARD) {
        isParaphrase = true;
        break;
      }
    }
    if (isParaphrase) continue;
    keptLines.push(line);
    keptSets.push(sig);
  }

  // Re-emit kept lines in a stable lexical order (independent of the
  // longest-first processing order) so the output is canonical.
  keptLines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Dedup is the ONLY compression: kept lines are a SUBSET of the children's
  // lines, so output tokens <= sum(children) always, and strictly less when
  // there was genuine redundancy to collapse. No lossy size-cap (codex P2):
  // force-trimming distinct lines to hit a target would drop facts that differ
  // only in a value token (which set-equality above deliberately preserves). A
  // non-redundant cluster simply yields a same-size summary - lossless, not
  // force-shrunk.
  return keptLines.join('\n');
}

/** Convenience overload over MemoryEntry[] (merge-pass call site). */
export function compressCluster(entries: MemoryEntry[]): string {
  return compressContents(entries.map((e) => e.content));
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
): Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> {
  const survivors = entries.filter((entry) => entry.layer !== Layer.Semantic && calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD);
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

