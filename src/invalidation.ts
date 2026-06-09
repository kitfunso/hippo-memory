import { loadAllEntries, writeEntry } from './store.js';

export interface InvalidationTarget {
  from: string;
  to: string | null;
  type: 'migration' | 'removal' | 'deprecation';
}

export interface InvalidationResult {
  invalidated: number;
  targets: string[];  // IDs of affected memories
  skippedPinned: string[];  // matched but pinned — never touched
  dryRun: boolean;
  preview: { id: string; headline: string }[];  // what was (or would be) hit
}

export interface InvalidationOptions {
  /** Evaluate matches but write nothing. */
  dryRun?: boolean;
  /** Consider ONLY this memory id (no content/tag matching). */
  onlyId?: string;
}

/**
 * Extract what was replaced/removed from a commit message.
 * Returns null if the commit isn't a breaking/migration change.
 */
export function extractInvalidationTarget(message: string): InvalidationTarget | null {
  // Strip conventional commit prefix (e.g., "feat(scope): ")
  const body = message.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim();

  // Pattern: "migrate/switch/move/convert/transition/upgrade from X to Y"
  const fromToMatch = body.match(
    /(?:migrat\w+|switch\w*|mov\w+|convert\w*|transition\w*|upgrad\w+)\s+(?:from\s+)?(.+?)\s+to\s+(.+)/i
  );
  if (fromToMatch) {
    return { from: fromToMatch[1].trim(), to: fromToMatch[2].trim(), type: 'migration' };
  }

  // Pattern: "from X to Y" (standalone)
  const standaloneFromTo = body.match(/from\s+(.+?)\s+to\s+(.+)/i);
  if (standaloneFromTo) {
    return { from: standaloneFromTo[1].trim(), to: standaloneFromTo[2].trim(), type: 'migration' };
  }

  // Pattern: "replace X with Y"
  const replaceMatch = body.match(/replac\w+\s+(.+?)\s+with\s+(.+)/i);
  if (replaceMatch) {
    return { from: replaceMatch[1].trim(), to: replaceMatch[2].trim(), type: 'migration' };
  }

  // Pattern: "deprecate X"
  const deprecateMatch = body.match(/deprecat\w+\s+(.+)/i);
  if (deprecateMatch) {
    return { from: deprecateMatch[1].trim(), to: null, type: 'deprecation' };
  }

  // Pattern: "remove/drop X" (but not trivial removals)
  const removeMatch = body.match(/(?:remov\w+|drop\w*)\s+(.+)/i);
  if (removeMatch) {
    const target = removeMatch[1].trim();
    const words = target.split(/\s+/);
    const trivialWords = new Set(['extra', 'unused', 'empty', 'old', 'whitespace', 'spaces', 'blank', 'dead', 'commented']);
    const isTrivial = words.length <= 2 && words.some(w => trivialWords.has(w.toLowerCase()));
    if (isTrivial) return null;
    return { from: target, to: null, type: 'removal' };
  }

  return null;
}

/**
 * Find memories that reference the invalidated pattern and weaken them.
 * - Halves half_life_days
 * - Sets confidence to 'stale'
 * - Adds 'invalidated' tag
 * - Skips pinned memories (reported in skippedPinned)
 *
 * Tag matching is EXACT (2026-06-09 incident): the FULL pattern must equal a
 * tag. Token-level matching applies to content only, so a pattern that merely
 * CONTAINS a common tag word ("hippo") can no longer mass-weaken every memory
 * carrying that tag. Both callers (the CLI `invalidate` command and the
 * auto-learn-from-git path) inherit this contract.
 */
export function invalidateMatching(
  hippoRoot: string,
  target: InvalidationTarget,
  tenantId?: string,
  options?: InvalidationOptions,
): InvalidationResult {
  // L9: tenantId opt-in. When provided, only this tenant's memories are
  // considered for weakening. When undefined, behaves as it did pre-1.12.1
  // (host-wide invalidation across all tenants in the store).
  // options.onlyId resolves by FILTERING this tenant-scoped list — never a
  // direct id lookup — so an id from another tenant is invisible here.
  const entries = loadAllEntries(hippoRoot, tenantId);
  const fromTokens = invalidationTokenize(target.from);
  const exactTag = target.from.toLowerCase().trim();
  const dryRun = options?.dryRun === true;
  const result: InvalidationResult = {
    invalidated: 0,
    targets: [],
    skippedPinned: [],
    dryRun,
    preview: [],
  };

  for (const entry of entries) {
    if (options?.onlyId !== undefined) {
      if (entry.id !== options.onlyId) continue;
    } else {
      const contentTokens = invalidationTokenize(entry.content);
      const tagTokens = entry.tags.map(t => t.toLowerCase());

      // Check if the memory references the old pattern
      const tokenMatch = matchScore(fromTokens, contentTokens);
      const tagMatch = tagTokens.includes(exactTag);

      if (!(tokenMatch >= 0.5 || tagMatch)) continue;
    }

    // Pinned check runs AFTER matching so pinned would-be targets are
    // observable in skippedPinned (pattern mode and onlyId mode alike).
    if (entry.pinned) {
      result.skippedPinned.push(entry.id);
      continue;
    }

    result.invalidated++;
    result.targets.push(entry.id);
    result.preview.push({ id: entry.id, headline: entry.content.slice(0, 60) });
    if (dryRun) continue;

    entry.half_life_days = Math.max(1, Math.floor(entry.half_life_days / 2));
    entry.confidence = 'stale';
    if (!entry.tags.includes('invalidated')) {
      entry.tags.push('invalidated');
    }
    writeEntry(hippoRoot, entry);
  }

  return result;
}

const STOPWORDS = new Set([
  'the', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of', 'by',
  'and', 'or', 'but', 'not', 'with', 'from', 'that', 'this', 'was', 'are',
  'be', 'has', 'had', 'have', 'been', 'will', 'would', 'could', 'should',
  'do', 'does', 'did', 'all', 'our', 'old', 'new', 'use', 'used', 'using',
]);

function invalidationTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_.-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

function matchScore(fromTokens: string[], contentTokens: string[]): number {
  if (fromTokens.length === 0) return 0;
  const contentSet = new Set(contentTokens);
  const matches = fromTokens.filter(t => contentSet.has(t)).length;
  return matches / fromTokens.length;
}
