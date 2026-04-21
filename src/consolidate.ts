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
} from './store.js';
import { textOverlap, markRetrieved } from './search.js';
import { openHippoDb, closeHippoDb } from './db.js';
import { loadPhysicsState, savePhysicsState, refreshParticleProperties } from './physics-state.js';
import { simulate, type ForceContext } from './physics.js';
import { loadConfig } from './config.js';
import { sampleForReplay } from './replay.js';
import { renderTraceContent } from './trace.js';

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
  dryRun: boolean;
  details: string[];
  physicsSimulated: number;
}

const REPLAY_COUNT_DEFAULT = 5;

/**
 * Run a full consolidation pass.
 */
export function consolidate(
  hippoRoot: string,
  options: { dryRun?: boolean; now?: Date } = {}
): ConsolidationResult {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;

  const result: ConsolidationResult = {
    decayed: 0,
    removed: 0,
    merged: 0,
    semanticCreated: 0,
    replayed: 0,
    promotedTraces: 0,
    dryRun,
    details: [],
    physicsSimulated: 0,
  };

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
    const promotable = findPromotableSessions(hippoRoot, sinceMs);

    for (const session of promotable) {
      // Idempotency: skip if a trace for this session already exists.
      if (traceExistsForSession(hippoRoot, session.session_id)) continue;

      const events = listSessionEvents(hippoRoot, {
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
  // 2. Physics simulation pass
  // -------------------------------------------------------------------------
  if (!dryRun) {
    try {
      const config = loadConfig(hippoRoot);
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
  const episodics = survivors.filter((e) => e.layer === Layer.Episodic);
  const used = new Set<string>();

  for (let i = 0; i < episodics.length; i++) {
    if (used.has(episodics[i].id)) continue;

    const cluster: MemoryEntry[] = [episodics[i]];

    for (let j = i + 1; j < episodics.length; j++) {
      if (used.has(episodics[j].id)) continue;
      const overlap = textOverlap(episodics[i].content, episodics[j].content);
      if (overlap >= MERGE_OVERLAP_THRESHOLD) {
        cluster.push(episodics[j]);
      }
    }

    if (cluster.length < MERGE_MIN_CLUSTER) continue;

    // Mark cluster members as used
    for (const e of cluster) used.add(e.id);
    result.merged += cluster.length;

    // Create a semantic summary
    const mergedContent = mergeContents(cluster);
    const allTags = Array.from(new Set(cluster.flatMap((e) => e.tags)));
    const maxValence = pickStrongestValence(cluster);

    result.details.push(
      `  🔀 merged ${cluster.length} episodic entries into semantic: "${mergedContent.slice(0, 60)}..."`
    );

    if (!dryRun) {
      const semantic = createMemory(mergedContent, {
        layer: Layer.Semantic,
        tags: allTags,
        emotional_valence: maxValence,
        schema_fit: 0.7,
        source: 'consolidation',
        confidence: 'inferred',
      });
      pendingWrites.push(semantic);
      result.semanticCreated++;

      // Reduce strength of source episodics (they've been compressed into neocortex)
      for (const e of cluster) {
        const weakened: MemoryEntry = { ...e, strength: e.strength * 0.3 };
        pendingWrites.push(weakened);
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

function mergeContents(entries: MemoryEntry[]): string {
  // Simple merge: take the longest entry as the base, prepend a summary note
  const sorted = [...entries].sort((a, b) => b.content.length - a.content.length);
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
): Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> {
  const survivors = entries.filter((entry) => entry.layer !== Layer.Semantic && calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD);
  const detected: Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> = [];

  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      // Traces are variants of each other, not contradictions. Two
      // strategies for the same task can both be valid; conflict detection
      // exists for stated-rule disagreement, not strategy diversity.
      if (survivors[i].layer === Layer.Trace && survivors[j].layer === Layer.Trace) continue;
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

