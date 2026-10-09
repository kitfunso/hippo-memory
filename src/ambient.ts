/**
 * Ambient state vector — a compact representation of the agent's memory
 * landscape, computed in O(N) from the current corpus.
 *
 * Inspired by the biological ambient neural state: a continuous background
 * representation that tells the agent "where it is" in knowledge-space
 * without retrieving specific memories.
 */

import { evalNow } from './ablation.js';
import type { MemoryEntry } from './memory.js';
import { Layer } from './memory.js';
import { calculateStrength } from './memory.js';
import { DAY_MS } from './util/time.js';

export interface AmbientState {
  tagEntropy: number;
  avgStrength: number;
  recencyFreshness: number;
  emotionalSkew: number;
  schemaFitRatio: number;
  errorDensity: number;
  consolidationRatio: number;
  conflictIntensity: number;
  extractionCoverage: number;
  dagDepth: number;
  totalMemories: number;
}

/** Row counts and sums an AmbientState is derived from; two stores' tallies add with addAmbientTallies. */
export interface AmbientTallies {
  total: number;
  strengthSum: number;
  fresh: number;
  negative: number;
  highSchemaFit: number;
  errors: number;
  semantic: number;
  episodic: number;
  conflicts: number;
  extracted: number;
  maxDagLevel: number;
  tagCounts: Map<string, number>;
}

/** The tallies of two disjoint row sets taken together. */
export function addAmbientTallies(a: AmbientTallies, b: AmbientTallies): AmbientTallies {
  const tagCounts = new Map(a.tagCounts);
  for (const [tag, count] of b.tagCounts) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + count);
  return {
    total: a.total + b.total,
    strengthSum: a.strengthSum + b.strengthSum,
    fresh: a.fresh + b.fresh,
    negative: a.negative + b.negative,
    highSchemaFit: a.highSchemaFit + b.highSchemaFit,
    errors: a.errors + b.errors,
    semantic: a.semantic + b.semantic,
    episodic: a.episodic + b.episodic,
    conflicts: a.conflicts + b.conflicts,
    extracted: a.extracted + b.extracted,
    maxDagLevel: Math.max(a.maxDagLevel, b.maxDagLevel),
    tagCounts,
  };
}

/** Whether a tag list marks its memory as an error for errorDensity. */
export function isErrorTagged(tags: readonly string[]): boolean {
  return tags.some(tag => tag === 'error' || tag === 'critical' || tag.startsWith('error:'));
}

/** Tallies over loaded entries; superseded rows count toward the total only, as they always have here. */
export function tallyAmbientEntries(entries: readonly MemoryEntry[], now?: Date): AmbientTallies {
  const currentTime = now ?? evalNow(); // honors HIPPO_FAKE_NOW (eval-only)
  const sevenDaysAgo = currentTime.getTime() - 7 * DAY_MS;
  const t: AmbientTallies = {
    total: entries.length, strengthSum: 0, fresh: 0, negative: 0, highSchemaFit: 0, errors: 0,
    semantic: 0, episodic: 0, conflicts: 0, extracted: 0, maxDagLevel: 0, tagCounts: new Map(),
  };
  for (const entry of entries) {
    if (entry.superseded_by) continue;
    for (const tag of entry.tags) t.tagCounts.set(tag, (t.tagCounts.get(tag) ?? 0) + 1);
    t.strengthSum += calculateStrength(entry, currentTime);
    if (new Date(entry.created).getTime() > sevenDaysAgo) t.fresh++;
    if (entry.emotional_valence === 'negative' || entry.emotional_valence === 'critical') t.negative++;
    if (isErrorTagged(entry.tags)) t.errors++;
    if (entry.schema_fit > 0.7) t.highSchemaFit++;
    if (entry.layer === Layer.Semantic) t.semantic++;
    if (entry.layer === Layer.Episodic) t.episodic++;
    t.conflicts += entry.conflicts_with.length;
    if (entry.extracted_from) t.extracted++;
    if (entry.dag_level > t.maxDagLevel) t.maxDagLevel = entry.dag_level;
  }
  return t;
}

export function computeAmbientState(entries: MemoryEntry[], now?: Date): AmbientState {
  return ambientStateFromTallies(tallyAmbientEntries(entries, now));
}

/** The ambient state of a row set from its tallies, however they were counted. */
export function ambientStateFromTallies(t: AmbientTallies): AmbientState {
  const n = t.total;
  if (n === 0) {
    return {
      tagEntropy: 0, avgStrength: 0, recencyFreshness: 0,
      emotionalSkew: 0, schemaFitRatio: 0, errorDensity: 0,
      consolidationRatio: 0, conflictIntensity: 0,
      extractionCoverage: 0, dagDepth: 0, totalMemories: 0,
    };
  }

  const tagEntropy = shannonEntropy(t.tagCounts, n);
  const avgStrength = t.strengthSum / n;
  const recencyFreshness = t.fresh / n;
  const emotionalSkew = (t.negative / n) * 2 - 0.5;
  const schemaFitRatio = t.highSchemaFit / n;
  const errorDensity = t.errors / n;
  const totalLayered = t.semantic + t.episodic;
  const consolidationRatio = totalLayered > 0 ? t.semantic / totalLayered : 0;
  const conflictIntensity = t.conflicts / (n * 2);
  const extractionCoverage = t.episodic > 0 ? t.extracted / t.episodic : 0;
  const maxDagLevel = t.maxDagLevel;

  return {
    tagEntropy,
    avgStrength,
    recencyFreshness,
    emotionalSkew: Math.max(-1, Math.min(1, emotionalSkew)),
    schemaFitRatio,
    errorDensity,
    consolidationRatio,
    conflictIntensity: Math.min(1, conflictIntensity),
    extractionCoverage: Math.min(1, extractionCoverage),
    dagDepth: maxDagLevel,
    totalMemories: n,
  };
}

function shannonEntropy(counts: Map<string, number>, total: number): number {
  if (counts.size === 0 || total === 0) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.max(counts.size, 2));
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

export function renderAmbientSummary(state: AmbientState): string {
  if (state.totalMemories === 0) return 'Memory state: empty store, no memories yet.';

  const parts: string[] = [];

  parts.push(`${state.totalMemories} memories`);

  if (state.recencyFreshness > 0.5) parts.push('mostly fresh (<7d)');
  else if (state.recencyFreshness < 0.1) parts.push('mostly aged');

  if (state.emotionalSkew > 0.3) parts.push('error-focused');
  else if (state.emotionalSkew < -0.3) parts.push('steady operation');

  if (state.consolidationRatio > 0.4) parts.push('well-consolidated');
  else if (state.consolidationRatio < 0.1) parts.push('mostly episodic');

  if (state.extractionCoverage > 0.5) parts.push('high extraction coverage');

  if (state.conflictIntensity > 0.1) parts.push(`${(state.conflictIntensity * 100).toFixed(0)}% conflict rate`);

  if (state.dagDepth >= 2) parts.push(`DAG depth ${state.dagDepth}`);

  if (state.avgStrength < 0.3) parts.push('low avg strength (aging corpus)');
  else if (state.avgStrength > 0.7) parts.push('high avg strength');

  if (state.tagEntropy > 0.8) parts.push('diverse topics');
  else if (state.tagEntropy < 0.3) parts.push('narrow focus');

  return `Memory state: ${parts.join(', ')}.`;
}

export function formatAmbientVector(state: AmbientState): string {
  const lines: string[] = [];
  lines.push('Ambient State Vector:');
  lines.push(`  tag_entropy:          ${state.tagEntropy.toFixed(3)}`);
  lines.push(`  avg_strength:         ${state.avgStrength.toFixed(3)}`);
  lines.push(`  recency_freshness:    ${state.recencyFreshness.toFixed(3)}`);
  lines.push(`  emotional_skew:       ${state.emotionalSkew.toFixed(3)}`);
  lines.push(`  schema_fit_ratio:     ${state.schemaFitRatio.toFixed(3)}`);
  lines.push(`  error_density:        ${state.errorDensity.toFixed(3)}`);
  lines.push(`  consolidation_ratio:  ${state.consolidationRatio.toFixed(3)}`);
  lines.push(`  conflict_intensity:   ${state.conflictIntensity.toFixed(3)}`);
  lines.push(`  extraction_coverage:  ${state.extractionCoverage.toFixed(3)}`);
  lines.push(`  dag_depth:            ${state.dagDepth}`);
  lines.push(`  total_memories:       ${state.totalMemories}`);
  return lines.join('\n');
}
