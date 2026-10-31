// Invalidation by text: finding the memories a migration, removal or deprecation names, and weakening them.
import { INVALIDATION_STOPWORDS } from '../../base/util/stopwords.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { EntryCursor } from '../../base/ports/store/types.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import type { HippoStore } from '../../base/ports/store.js';
import type { LessonWrites } from '../../base/records/lesson-writes.js';
import type { Learning } from '../../base/records/learning.js';

const HEADLINE_CHARS = 60;
// The share of a row's tokens that must match the target's before the row counts as mentioning it.
const MENTION_TOKEN_MATCH_MIN = 0.5;

export interface InvalidationTarget {
  from: string;
  to: string | null;
  type: 'migration' | 'removal' | 'deprecation';
}

export interface InvalidationResult {
  invalidated: number;
  targets: string[]; // IDs of affected memories
  skippedPinned: string[]; // matched but pinned — never touched
  dryRun: boolean;
  preview: { id: string; headline: string }[]; // what was (or would be) hit
}

export interface InvalidationOptions {
  /** Evaluate matches but write nothing. */
  dryRun?: boolean;
  /** Consider ONLY this memory id (no content/tag matching). */
  onlyId?: string;
}

const TRIVIAL_REMOVAL_WORDS = new Set([
  'extra',
  'unused',
  'empty',
  'old',
  'whitespace',
  'spaces',
  'blank',
  'dead',
  'commented',
]);

function isTrivialRemoval(target: string): boolean {
  const words = target.split(/\s+/);
  return words.length <= 2 && words.some((w) => TRIVIAL_REMOVAL_WORDS.has(w.toLowerCase()));
}

interface InvalidationPattern {
  readonly re: RegExp;
  readonly type: InvalidationTarget['type'];
  /** Group 2 names the replacement. */
  readonly hasTo: boolean;
  /** A match this refuses ends the search with no target. */
  readonly refuses?: (from: string) => boolean;
}

// Ordered: the first pattern that matches wins.
const INVALIDATION_PATTERNS: readonly InvalidationPattern[] = [
  {
    re: /(?:migrat\w+|switch\w*|mov\w+|convert\w*|transition\w*|upgrad\w+)\s+(?:from\s+)?(.+?)\s+to\s+(.+)/i,
    type: 'migration',
    hasTo: true,
  },
  { re: /from\s+(.+?)\s+to\s+(.+)/i, type: 'migration', hasTo: true },
  { re: /replac\w+\s+(.+?)\s+with\s+(.+)/i, type: 'migration', hasTo: true },
  { re: /deprecat\w+\s+(.+)/i, type: 'deprecation', hasTo: false },
  { re: /(?:remov\w+|drop\w*)\s+(.+)/i, type: 'removal', hasTo: false, refuses: isTrivialRemoval },
];

/** Extract what was replaced/removed from a commit message.
 *  Returns null if the commit isn't a breaking/migration change. */
export function extractInvalidationTarget(message: string): InvalidationTarget | null {
  const body = message.replace(/^[a-z]+(\([^)]*\))?:\s*/i, '').trim();
  for (const { re, type, hasTo, refuses } of INVALIDATION_PATTERNS) {
    const match = body.match(re);
    if (!match) continue;
    const from = match[1].trim();
    if (refuses?.(from)) return null;
    return { from, to: hasTo ? match[2].trim() : null, type };
  }
  return null;
}

/** Find memories that reference the invalidated pattern and weaken them (halve half_life_days,
 * confidence 'stale', add 'invalidated' tag; pinned are skipped). Tag matching is EXACT: the
 * FULL pattern must equal a tag, so a pattern merely containing a common tag word cannot
 * mass-weaken every memory with that tag. */
export async function invalidateMatching(
  store: HippoStore & {
    readonly hippoDb: { readonly learning: Learning; readonly lessonWrites: LessonWrites };
  },
  target: InvalidationTarget,
  tenantId: string,
  options?: InvalidationOptions,
): Promise<InvalidationResult> {
  // Only that tenant's memories are weakened; the onlyId read is tenant-scoped, so another tenant's
  // id is invisible.
  if (options?.onlyId !== undefined) {
    const entries = [await store.hippoDb.learning.readEntry(options.onlyId, tenantId)].filter(
      (entry) => entry !== null,
    );
    const { result, weakened } = weakenMatches(entries, target, options);
    await store.hippoDb.lessonWrites.writeTogether(weakened);
    return result;
  }
  const { tokens, tag } = mentionOf(target);
  const result = emptyResult(options?.dryRun === true);
  const weakened: MemoryEntry[] = [];
  let after: EntryCursor | undefined;
  do {
    const page = await store.hippoDb.learning.entriesMentioning(tokens, tag, tenantId, {
      limit: READ_PAGE_ROWS,
      after,
    });
    const found = weakenMatches(page.entries, target, options);
    result.invalidated += found.result.invalidated;
    result.targets.push(...found.result.targets);
    result.skippedPinned.push(...found.result.skippedPinned);
    result.preview.push(...found.result.preview);
    weakened.push(...found.weakened);
    after = page.next ?? undefined;
  } while (after);
  // One write for every page, so a failed invalidation weakens none of them.
  await store.hippoDb.lessonWrites.writeTogether(weakened);
  return result;
}

/** invalidateMatching for a batch: matches against `live`, the caller's list of the tenant's
 * rows, and keeps it current. Each match is read again before it is weakened, so a row another
 * writer changed since the list was read is never written back stale. */
export async function invalidateMatchingAmong(
  store: HippoStore & { readonly hippoDb: { readonly lessonWrites: LessonWrites } },
  live: MemoryEntry[],
  target: InvalidationTarget,
  tenantId: string,
): Promise<InvalidationResult> {
  const seen = weakenMatches(live, target, { dryRun: true }).result;
  const ids = [...seen.targets, ...seen.skippedPinned];
  const fresh = new Map(
    (await store.entriesByIds(ids, tenantId)).map((entry) => [entry.id, entry]),
  );
  const { result, weakened } = weakenMatches(
    ids.flatMap((id) => fresh.get(id) ?? []),
    target,
  );
  if (weakened.length > 0) await store.hippoDb.lessonWrites.writeTogether(weakened);
  const byId = new Map(weakened.map((entry) => [entry.id, entry]));
  for (let i = 0; i < live.length; i++) live[i] = byId.get(live[i].id) ?? live[i];
  return result;
}

/** Whether `entry` is a row any of `targets` would weaken or skip, by the match pass's own test. */
export function invalidationMatcher(
  targets: readonly InvalidationTarget[],
): (entry: MemoryEntry) => boolean {
  const patterns = targets.map(mentionOf);
  return (entry) => patterns.some((p) => referencesPattern(entry, p.tokens, p.tag));
}

/** What a row must mention to match a target: enough of its tokens, or its exact tag. */
interface Mention {
  readonly tokens: string[];
  readonly tag: string;
}

/** The tokens and the exact tag a row must mention to match `target`. */
function mentionOf(target: InvalidationTarget): Mention {
  return { tokens: invalidationTokenize(target.from), tag: target.from.toLowerCase().trim() };
}

function emptyResult(dryRun: boolean): InvalidationResult {
  return { invalidated: 0, targets: [], skippedPinned: [], dryRun, preview: [] };
}

function referencesPattern(entry: MemoryEntry, fromTokens: string[], exactTag: string): boolean {
  const contentTokens = invalidationTokenize(entry.content);
  const tagTokens = entry.tags.map((t) => t.toLowerCase());
  const tokenMatch = matchScore(fromTokens, contentTokens);
  const tagMatch = tagTokens.includes(exactTag);
  return tokenMatch >= MENTION_TOKEN_MATCH_MIN || tagMatch;
}

/** The match pass: weakens each unpinned match in place and returns them, writing nothing. */
function weakenMatches(
  entries: readonly MemoryEntry[],
  target: InvalidationTarget,
  options?: InvalidationOptions,
) {
  const { tokens, tag } = mentionOf(target);
  const dryRun = options?.dryRun === true;
  const result = emptyResult(dryRun);
  const weakened: MemoryEntry[] = [];

  for (const entry of entries) {
    if (options?.onlyId !== undefined) {
      if (entry.id !== options.onlyId) continue;
    } else if (!referencesPattern(entry, tokens, tag)) continue;

    // Pinned check runs AFTER matching so pinned would-be targets are observable in skippedPinned
    // (pattern mode and onlyId mode alike).
    if (entry.pinned) {
      result.skippedPinned.push(entry.id);
      continue;
    }

    countTarget(result, entry);
    if (dryRun) continue;

    weakenEntry(entry);
    weakened.push(entry);
  }

  return { result, weakened };
}

/** The one-line text a preview row shows for an entry. */
export function previewHeadline(entry: MemoryEntry): string {
  return entry.content.replace(/\s+/g, ' ').slice(0, HEADLINE_CHARS);
}

function countTarget(result: InvalidationResult, entry: MemoryEntry): void {
  result.invalidated++;
  result.targets.push(entry.id);
  result.preview.push({
    id: entry.id,
    headline: previewHeadline(entry),
  });
}

function weakenEntry(entry: MemoryEntry): void {
  entry.halfLifeDays = Math.max(1, Math.floor(entry.halfLifeDays / 2));
  entry.confidence = 'stale';
  if (!entry.tags.includes('invalidated')) {
    entry.tags.push('invalidated');
  }
}

function invalidationTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_.-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !INVALIDATION_STOPWORDS.has(t));
}

function matchScore(fromTokens: string[], contentTokens: string[]): number {
  if (fromTokens.length === 0) return 0;
  const contentSet = new Set(contentTokens);
  const matches = fromTokens.filter((t) => contentSet.has(t)).length;
  return matches / fromTokens.length;
}
