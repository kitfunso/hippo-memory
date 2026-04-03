/**
 * Consolidation engine ("Sleep") for Hippo.
 *
 * Steps:
 * 1. Decay pass  - remove entries below strength threshold
 * 2. Merge pass  - find episodic entries with high text overlap, create semantic summaries
 * 3. Stats tracking
 */

import { MemoryEntry, Layer, calculateStrength, createMemory, resolveConfidence } from './memory.js';
import {
  loadAllEntries,
  writeEntry,
  deleteEntry,
  batchWriteAndDelete,
  appendConsolidationRun,
  replaceDetectedConflicts,
} from './store.js';
import { textOverlap } from './search.js';

const DECAY_THRESHOLD = 0.05;
const MERGE_OVERLAP_THRESHOLD = 0.35;  // Jaccard similarity for "related"
const MERGE_MIN_CLUSTER = 2;            // minimum cluster size to merge

export interface ConsolidationResult {
  decayed: number;
  removed: number;
  merged: number;
  semanticCreated: number;
  dryRun: boolean;
  details: string[];
}

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
    dryRun,
    details: [],
  };

  const all = loadAllEntries(hippoRoot);

  // Collect all writes/deletes and batch them at the end
  const pendingWrites: MemoryEntry[] = [];
  const pendingDeletes: string[] = [];

  // -------------------------------------------------------------------------
  // 1. Decay pass
  // -------------------------------------------------------------------------
  const survivors: MemoryEntry[] = [];
  for (const entry of all) {
    const strength = calculateStrength(entry, now);

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
  // 2. Merge pass  - episodic entries only
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
  // 3. Log run
  // -------------------------------------------------------------------------
  if (!dryRun) {
    const detectedConflicts = detectConflicts(survivors, now);
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
): Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> {
  const survivors = entries.filter((entry) => entry.layer !== Layer.Semantic && calculateStrength(entry, now) >= DECAY_THRESHOLD);
  const detected: Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> = [];

  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
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
  const strippedOverlap = textOverlap(stripConflictPolarity(a.content), stripConflictPolarity(b.content));
  const rawOverlap = textOverlap(a.content, b.content);
  const tagOverlap = jaccard(a.tags, b.tags);
  const overlapScore = Math.max(strippedOverlap, rawOverlap, tagOverlap * 0.75);

  if (overlapScore < 0.55) return null;

  const polarityA = inferConflictPolarity(a.content);
  const polarityB = inferConflictPolarity(b.content);
  const conflictType = classifyConflictType(a.content, b.content, polarityA, polarityB);
  if (!conflictType) return null;

  return {
    reason: conflictType,
    score: overlapScore,
  };
}

function classifyConflictType(
  aText: string,
  bText: string,
  aPolarity: 'positive' | 'negative' | 'neutral',
  bPolarity: 'positive' | 'negative' | 'neutral',
): string | null {
  const a = aText.toLowerCase();
  const b = bText.toLowerCase();

  const enabledDisabled = (containsAny(a, ['enabled', 'enable', 'on']) && containsAny(b, ['disabled', 'disable', 'off']))
    || (containsAny(b, ['enabled', 'enable', 'on']) && containsAny(a, ['disabled', 'disable', 'off']));
  if (enabledDisabled) return 'enabled/disabled mismatch on overlapping statement';

  const trueFalse = (containsAny(a, [' true ', ' true.', ' true,', ' yes ']) && containsAny(b, [' false ', ' false.', ' false,', ' no ']))
    || (containsAny(b, [' true ', ' true.', ' true,', ' yes ']) && containsAny(a, [' false ', ' false.', ' false,', ' no ']));
  if (trueFalse) return 'true/false mismatch on overlapping statement';

  const alwaysNever = (containsAny(a, ['always', 'must']) && containsAny(b, ['never', 'must not']))
    || (containsAny(b, ['always', 'must']) && containsAny(a, ['never', 'must not']));
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

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((item) => item.toLowerCase()));
  const setB = new Set(b.map((item) => item.toLowerCase()));
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
