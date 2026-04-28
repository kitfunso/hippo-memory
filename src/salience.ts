/**
 * Salience gate — decides at memory creation time whether content is worth
 * storing at full strength, should start weakened, or should be skipped.
 *
 * Inspired by the biological salience network (anterior insula + dACC):
 * not everything that enters working memory deserves long-term storage.
 */

import type { MemoryEntry } from './memory.js';
import { textOverlap } from './search.js';

export type SalienceDecision = 'store' | 'skip' | 'start_weak';

export interface SalienceResult {
  decision: SalienceDecision;
  reason: string;
  score: number;
}

export interface SalienceOptions {
  recentWindow?: number;
  overlapThreshold?: number;
  minContentLength?: number;
  maxRepeatErrors?: number;
}

const DEFAULTS: Required<SalienceOptions> = {
  recentWindow: 20,
  overlapThreshold: 0.6,
  minContentLength: 5,
  maxRepeatErrors: 4,
};

export function computeSalience(
  content: string,
  tags: string[],
  recentMemories: MemoryEntry[],
  options: SalienceOptions = {},
): SalienceResult {
  const opts = { ...DEFAULTS, ...options };
  const trimmed = content.trim();
  const isPinned = tags.includes('pinned');

  if (isPinned) {
    return { decision: 'store', reason: 'pinned', score: 1.0 };
  }

  if (trimmed.length < opts.minContentLength) {
    return { decision: 'skip', reason: 'content_too_short', score: 0 };
  }

  const isError = tags.some(t =>
    t === 'error' || t === 'critical' || t.startsWith('error:')
  );

  const window = recentMemories.slice(-opts.recentWindow);

  const duplicateMatch = findBestOverlap(trimmed, window);
  if (duplicateMatch.overlap > opts.overlapThreshold) {
    if (isError) {
      const recentErrors = countRecentErrors(window);
      if (recentErrors >= opts.maxRepeatErrors) {
        return {
          decision: 'start_weak',
          reason: `repeat_error (${recentErrors} recent errors, overlap ${(duplicateMatch.overlap * 100).toFixed(0)}% with ${duplicateMatch.matchId})`,
          score: 0.3,
        };
      }
      return { decision: 'store', reason: 'error_despite_overlap', score: 0.7 };
    }
    return {
      decision: 'skip',
      reason: `duplicate (${(duplicateMatch.overlap * 100).toFixed(0)}% overlap with ${duplicateMatch.matchId})`,
      score: 0.1,
    };
  }

  if (isError) {
    return { decision: 'store', reason: 'error_novel', score: 0.9 };
  }

  const hasStructuredTags = tags.some(t =>
    t.startsWith('speaker:') || t.startsWith('topic:') || t.startsWith('scope:')
  );

  let score = 0.5;
  if (hasStructuredTags) score += 0.15;
  if (trimmed.length > 100) score += 0.1;
  if (trimmed.length > 300) score += 0.1;

  return { decision: 'store', reason: 'novel', score: Math.min(score, 1.0) };
}

function findBestOverlap(
  content: string,
  memories: MemoryEntry[],
): { overlap: number; matchId: string | null } {
  let best = 0;
  let matchId: string | null = null;
  for (const m of memories) {
    const overlap = textOverlap(content, m.content);
    if (overlap > best) {
      best = overlap;
      matchId = m.id;
    }
  }
  return { overlap: best, matchId };
}

function countRecentErrors(memories: MemoryEntry[]): number {
  return memories.filter(m =>
    m.emotional_valence === 'negative' || m.emotional_valence === 'critical'
  ).length;
}
