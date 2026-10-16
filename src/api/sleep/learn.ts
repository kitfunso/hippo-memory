// Git auto-learn: fix/revert/bug commit subjects become memories.
// `hippo learn`, init, sleep and MCP hippo_learn share it.

import { ForbiddenError } from '../../core/api-errors.js';
import { fetchGitLog, extractLessons, partitionLessons, isGitRepo } from '../../learn/autolearn.js';
import type { HippoConfig } from '../../core/config.js';
import { configOf } from '../config-of.js';
import { embedMemory } from '../../search/embed-memories.js';
import {
  extractInvalidationTarget,
  invalidateMatching,
  invalidateMatchingAmong,
  type InvalidationOptions,
  type InvalidationResult,
  type InvalidationTarget,
} from '../../learn/invalidation.js';
import { createMemory, Layer, schemaFitFrom, schemaFitSourceOf, type MemoryEntry } from '../../core/memory.js';
import { extractPathTags } from '../../search/path-context.js';
import { canReadScope, personalScopeOf } from '../../core/recall-scope.js';
import { duplicateKey, longestWord, storedTextKeys } from '../../util/same-text.js';
import type { LessonWrites } from '../../store/port.js';
import type { Context, ContextWith, StoreContext } from '../types.js';

/** How a surface writes what it learns. */
export interface LearnProfile {
  readonly tags: readonly string[];
  readonly source: string;
  /** Also invalidate what a migration subject supersedes, score schema fit, path-tag, count and embed each row. */
  readonly full: boolean;
}

// SHORTCUT: two profiles keep each surface's rows as they were; fold MCP onto the CLI profile once it may invalidate.
export const CLI_LEARN: LearnProfile = Object.freeze({
  tags: Object.freeze(['error', 'git-learned']),
  source: 'git-learn',
  full: true,
});
export const MCP_LEARN: LearnProfile = Object.freeze({
  tags: Object.freeze(['git-learned']),
  source: 'git',
  full: false,
});

export interface LearnOpts {
  repoPath: string;
  days: number;
  profile: LearnProfile;
}

export interface LearnResult {
  /** `no-commits`: an empty git log; `no-lessons`: a log with no lesson-shaped subject. */
  status: 'not-a-repo' | 'no-commits' | 'no-lessons' | 'scanned';
  added: number;
  skipped: number;
  rejected: number;
  lowInfo: number;
  /** Each lesson whose migration target weakened at least one memory, in scan order. */
  invalidations: Array<{ from: string; count: number }>;
}

type LessonCounts = Pick<LearnResult, 'added' | 'skipped' | 'rejected' | 'invalidations'>;

/** Learn from `repoPath`'s last `days` of commits into the caller's tenant. Host admin only. */
export async function learn(ctx: ContextWith<'lessonWrites'>, opts: LearnOpts): Promise<LearnResult> {
  // It reads the host's own git history, which belongs to the host, not to the caller's tenant.
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('hippo_learn requires a host admin');
  const none = { added: 0, skipped: 0, rejected: 0, lowInfo: 0, invalidations: [] };
  if (!isGitRepo(opts.repoPath)) return { status: 'not-a-repo', ...none };
  const gitLog = fetchGitLog(opts.repoPath, opts.days);
  if (!gitLog.trim()) return { status: 'no-commits', ...none };
  const config = configOf(ctx);
  const parsed = extractLessons(gitLog, config.gitLearnPatterns);
  if (parsed.length === 0) return { status: 'no-lessons', ...none };
  // The gate filters the loop input, so a dropped lesson neither stores nor invalidates; docs/decisions
  // git-learn-gate-placement says why.
  const { kept, dropped } = partitionLessons(parsed);
  return { status: 'scanned', lowInfo: dropped.length, ...await writeLessons(ctx, kept, opts, config) };
}

interface QueuedLesson { entry: MemoryEntry; key: string }

/** Where a batch writes and what it has learned so far: `live` and
 * `keys` follow every write, so a later lesson matches against them. */
interface LessonBatch {
  readonly ctx: Context;
  readonly writes: LessonWrites;
  readonly live: MemoryEntry[];
  readonly keys: Set<string>;
  readonly counts: LessonCounts;
  readonly full: boolean;
}

/** Writes `queued` in one transaction; a refused lesson is dropped from `live` and `keys` and must not abort the rest
 * of the git-log scan. */
async function landLessons(batch: LessonBatch, queued: readonly QueuedLesson[]): Promise<void> {
  if (queued.length === 0) return;
  const { ctx, writes, live, keys, counts } = batch;
  const written = new Set(await writes.writeSkippingRejected(queued.map((q) => q.entry), ctx.actor.subject));
  const landed: MemoryEntry[] = [];
  for (const { entry, key } of queued) {
    if (written.has(entry.id)) {
      landed.push(entry);
      continue;
    }
    counts.rejected++;
    keys.delete(key);
    const at = live.indexOf(entry);
    if (at !== -1) live.splice(at, 1);
  }
  counts.added += landed.length;
  if (!batch.full) return;
  if (landed.length > 0) await writes.bumpRemembered(landed.length);
  for (const entry of landed) void embedMemory(ctx.hippoRoot, entry, undefined, ctx.store);
}

/** The duplicate keys a batch skips: every readable row's with
 * `existing`, else only the rows holding a lesson's longest word. */
async function knownKeys(
  ctx: StoreContext,
  writes: LessonWrites,
  lessons: readonly string[],
  existing: readonly MemoryEntry[] | undefined,
): Promise<Set<string>> {
  return storedTextKeys(
    existing ?? (await writes.textsHoldingWords(ctx.tenantId, lessons.map(longestWord), personalScopeOf(ctx.actor))),
  );
}

interface LessonMemoryInputs {
  readonly tenantId: string;
  readonly config: HippoConfig;
  readonly fitSource: ReturnType<typeof schemaFitSourceOf> | undefined;
  readonly pathTags: readonly string[];
}

function newLessonMemory(lesson: string, profile: LearnProfile, inputs: LessonMemoryInputs): MemoryEntry {
  const { tenantId, config, fitSource, pathTags } = inputs;
  const entry = createMemory(lesson, {
    layer: Layer.Episodic,
    tags: [...profile.tags],
    source: profile.source,
    confidence: 'observed',
    schemaFit: fitSource && schemaFitFrom(lesson, [...profile.tags], fitSource),
    tenantId,
    baseHalfLifeDays: config.defaultHalfLifeDays,
  });
  for (const tag of pathTags) if (!entry.tags.includes(tag)) entry.tags.push(tag);
  return entry;
}

async function writeLessons(
  ctx: ContextWith<'lessonWrites'>,
  lessons: readonly string[],
  opts: LearnOpts,
  config: HippoConfig,
): Promise<LessonCounts> {
  const { tenantId } = ctx;
  const { profile } = opts;
  const store = ctx.store;
  const writes = store.lessonWrites;
  // One read serves the batch: invalidation matches against `live`,
  // which follows every write below, as a reload per lesson did.
  const live = profile.full ? await writes.tenantEntries(tenantId) : [];
  // Schema fit needs every row; without it, only rows holding a lesson's longest word can be its copy. Learn is
  // host-admin only, so both read what an admin can.
  const existing = profile.full ? live.filter((e) => e.scope == null || canReadScope(ctx.actor, e.scope)) : undefined;
  // Each lesson is scored against `existing` as it was before the batch, so its tag counts and texts are read once.
  const fitSource = existing && schemaFitSourceOf(existing);
  const batch: LessonBatch = {
    ctx, writes, live, keys: await knownKeys(ctx, writes, lessons, existing), full: profile.full,
    counts: { added: 0, skipped: 0, rejected: 0, invalidations: [] },
  };
  const pathTags = profile.full ? extractPathTags(opts.repoPath) : [];
  // Lessons queue and land in one transaction; an invalidation reads the store, so it flushes the queue first.
  const queue: QueuedLesson[] = [];
  for (const lesson of lessons) {
    const key = duplicateKey(lesson);
    if (batch.keys.has(key)) { batch.counts.skipped++; continue; }
    const target = profile.full ? extractInvalidationTarget(lesson) : null;
    if (target) {
      await landLessons(batch, queue.splice(0));
      const { invalidated } = await invalidateMatchingAmong(store, live, target, tenantId);
      if (invalidated > 0) batch.counts.invalidations.push({ from: target.from, count: invalidated });
    }
    const entry = newLessonMemory(lesson, profile, { tenantId, config, fitSource, pathTags });
    queue.push({ entry, key });
    if (profile.full) live.push(entry);
    batch.keys.add(key);
  }
  await landLessons(batch, queue.splice(0));
  return batch.counts;
}

export type { InvalidationOptions, InvalidationResult, InvalidationTarget };

/** `hippo invalidate`: weakens the caller's tenant's memories that
 * reference `target.from`, or only the one `options.onlyId` names. */
export function invalidateMemories(
  ctx: Context,
  target: InvalidationTarget,
  options: InvalidationOptions,
): InvalidationResult {
  return invalidateMatching(ctx.hippoRoot, target, ctx.tenantId, options);
}
