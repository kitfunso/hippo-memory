/**
 * Salience gate — decides at memory creation time whether content is worth
 * storing at full strength, should start weakened, or should be skipped.
 *
 * Inspired by the biological salience network (anterior insula + dACC):
 * not everything that enters working memory deserves long-term storage.
 */

import type { MemoryEntry } from './memory.js';
import { textOverlap } from './tokenize.js';
import { duplicateKey, heldTextKeys } from './same-text.js';

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

// Each store or skip reason carries a score; a novel memory adds bonuses for structure and length.
const REPEAT_ERROR_SCORE = 0.3;
const ERROR_DESPITE_OVERLAP_SCORE = 0.7;
const NEAR_DUPLICATE_SCORE = 0.5;
const DUPLICATE_SCORE = 0.1;
const NOVEL_ERROR_SCORE = 0.9;
const NOVEL_BASE_SCORE = 0.5;
const STRUCTURED_TAGS_BONUS = 0.15;
const LENGTH_BONUS = 0.1;

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
          score: REPEAT_ERROR_SCORE,
        };
      }
      return { decision: 'store', reason: 'error_despite_overlap', score: ERROR_DESPITE_OVERLAP_SCORE };
    }
    return judgeOverlappingNonError(trimmed, window, duplicateMatch);
  }

  if (isError) {
    return { decision: 'store', reason: 'error_novel', score: NOVEL_ERROR_SCORE };
  }

  return scoreNovel(trimmed, tags);
}

function judgeOverlappingNonError(
  trimmed: string,
  window: MemoryEntry[],
  duplicateMatch: ReturnType<typeof findBestOverlap>,
): SalienceResult {
  // A near-duplicate may be a changed value (port 8080 then 8081), so only the same text is skipped.
  const key = duplicateKey(trimmed);
  const same = window.find((m) => heldTextKeys(m).includes(key));
  if (!same) {
    return {
      decision: 'store',
      reason: `near_duplicate (${(duplicateMatch.overlap * 100).toFixed(0)}% overlap with ${duplicateMatch.matchId})`,
      score: NEAR_DUPLICATE_SCORE,
    };
  }
  return { decision: 'skip', reason: `duplicate (same text as ${same.id})`, score: DUPLICATE_SCORE };
}

function scoreNovel(trimmed: string, tags: string[]): SalienceResult {
  const hasStructuredTags = tags.some(t =>
    t.startsWith('speaker:') || t.startsWith('topic:') || t.startsWith('scope:')
  );

  let score = NOVEL_BASE_SCORE;
  if (hasStructuredTags) score += STRUCTURED_TAGS_BONUS;
  if (trimmed.length > 100) score += LENGTH_BONUS;
  if (trimmed.length > 300) score += LENGTH_BONUS;

  return { decision: 'store', reason: 'novel', score: Math.min(score, 1.0) };
}

function findBestOverlap(
  content: string,
  memories: MemoryEntry[],
) {
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
