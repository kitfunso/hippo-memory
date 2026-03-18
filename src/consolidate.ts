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
  appendConsolidationRun,
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
        deleteEntry(hippoRoot, entry.id);
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
        writeEntry(hippoRoot, updated);
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
      writeEntry(hippoRoot, semantic);
      result.semanticCreated++;

      // Reduce strength of source episodics (they've been compressed into neocortex)
      for (const e of cluster) {
        const weakened: MemoryEntry = { ...e, strength: e.strength * 0.3 };
        writeEntry(hippoRoot, weakened);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 3. Log run
  // -------------------------------------------------------------------------
  if (!dryRun) {
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
