/**
 * Ambient state vector — a compact representation of the agent's memory
 * landscape, computed in O(N) from the current corpus.
 *
 * Inspired by the biological ambient neural state: a continuous background
 * representation that tells the agent "where it is" in knowledge-space
 * without retrieving specific memories.
 */

import type { MemoryEntry } from './memory.js';
import { Layer } from './memory.js';
import { calculateStrength } from './memory.js';

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

export function computeAmbientState(entries: MemoryEntry[], now?: Date): AmbientState {
  const n = entries.length;
  if (n === 0) {
    return {
      tagEntropy: 0, avgStrength: 0, recencyFreshness: 0,
      emotionalSkew: 0, schemaFitRatio: 0, errorDensity: 0,
      consolidationRatio: 0, conflictIntensity: 0,
      extractionCoverage: 0, dagDepth: 0, totalMemories: 0,
    };
  }

  const currentTime = now ?? new Date();

  const tagCounts = new Map<string, number>();
  let strengthSum = 0;
  let freshCount = 0;
  let negativeCount = 0;
  let highSchemaCount = 0;
  let errorCount = 0;
  let semanticCount = 0;
  let episodicCount = 0;
  let conflictSum = 0;
  let extractedCount = 0;
  let maxDagLevel = 0;

  const sevenDaysAgo = currentTime.getTime() - 7 * 86400000;

  for (const entry of entries) {
    if (entry.superseded_by) continue;

    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    const strength = calculateStrength(entry, currentTime);
    strengthSum += strength;

    if (new Date(entry.created).getTime() > sevenDaysAgo) freshCount++;

    if (entry.emotional_valence === 'negative' || entry.emotional_valence === 'critical') {
      negativeCount++;
    }
    if (entry.tags.some(t => t === 'error' || t === 'critical' || t.startsWith('error:'))) {
      errorCount++;
    }
    if (entry.schema_fit > 0.7) highSchemaCount++;

    if (entry.layer === Layer.Semantic) semanticCount++;
    if (entry.layer === Layer.Episodic) episodicCount++;

    conflictSum += entry.conflicts_with.length;

    if (entry.extracted_from) extractedCount++;
    if (entry.dag_level > maxDagLevel) maxDagLevel = entry.dag_level;
  }

  const tagEntropy = shannonEntropy(tagCounts, n);
  const avgStrength = strengthSum / n;
  const recencyFreshness = freshCount / n;
  const emotionalSkew = (negativeCount / n) * 2 - 0.5;
  const schemaFitRatio = highSchemaCount / n;
  const errorDensity = errorCount / n;
  const totalLayered = semanticCount + episodicCount;
  const consolidationRatio = totalLayered > 0 ? semanticCount / totalLayered : 0;
  const conflictIntensity = conflictSum / (n * 2);
  const extractionCoverage = episodicCount > 0 ? extractedCount / episodicCount : 0;

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
