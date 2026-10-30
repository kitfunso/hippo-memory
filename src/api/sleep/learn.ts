// Git auto-learn: fix/revert/bug commit subjects become memories.
// `hippo learn`, init, sleep and MCP hippo_learn share it.

import { ForbiddenError } from '../../base/errors/api-errors.js';
import { fetchGitLog, extractLessons, partitionLessons } from '../../domain/learn/autolearn.js';
import type { HippoConfig } from '../../base/config/config.js';
import { isGitRepo, type GitRunner } from '../../base/ports/git.js';
import { embedMemoryDetached } from '../../domain/search/embed-memories.js';
import { withDetached } from '../detached.js';
import {
  extractInvalidationTarget,
  invalidateMatching,
  invalidationMatcher,
  invalidateMatchingAmong,
  type InvalidationOptions,
  type InvalidationResult,
  type InvalidationTarget,
} from '../../domain/learn/invalidation.js';
import {
  createMemory,
  ERROR_TAG,
  Layer,
  schemaFitFrom,
  type MemoryEntry,
  type SchemaFitSource,
} from '../../base/memory/entry.js';
import { extractPathTags } from '../../domain/search/path-context.js';
import { canReadScope, personalScopeOf } from '../../base/scope/recall-scope.js';
import { duplicateKey, heldTextKeys, storedTextKeys } from '../../base/util/same-text.js';
import type { LessonWrites } from '../../base/ports/store.js';
import { memoryPages } from '../memories/memories.js';
import { strengthOf, type Context, type ContextWith } from '../types.js';
import type { HippoDbContext } from '../hippo-db-context.js';

/** A learn writes its lessons through lessonWrites and counts them on hippo.db's local tier. */
type LearnContext = ContextWith<'lessonWrites'> & HippoDbContext;

/** How a surface writes what it learns. */
export interface LearnProfile {
  readonly tags: readonly string[];
  readonly source: string;
  /** Also invalidate what a migration subject supersedes, score schema fit, path-tag, count and
   * embed each row. */
  readonly full: boolean;
}

// SHORTCUT: two profiles keep each surface's rows as they were; fold MCP onto the CLI profile once
// it may invalidate.
export const CLI_LEARN: LearnProfile = Object.freeze({
  tags: Object.freeze([ERROR_TAG, 'git-learned']),
  source: 'git-learn',
  full: true,
});
export const MCP_LEARN: LearnProfile = Object.freeze({
  tags: Object.freeze(['git-learned']),
  source: 'git',
  full: false,
});

export interface LearnOptions {
  /** The repo to read; absent, the folder the context's machine runs in. */
  repoPath?: string;
  days: number;
  profile: LearnProfile;
  /** Runs the git reads, since the api layer never starts a process; absent, the machine's git. */
  git?: GitRunner;
  /** Rows read per page of the tenant scan; defaults to TENANT_PAGE_ROWS. */
  pageRows?: number;
}

// A page bounds what one read holds, so a large tenant never sits in memory as rows.
const TENANT_PAGE_ROWS = 500;

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
export async function learn(ctx: LearnContext, opts: LearnOptions): Promise<LearnResult> {
  // It reads the host's own git history, which belongs to the host, not to the caller's tenant.
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('hippo_learn requires a host admin');
  const none = { added: 0, skipped: 0, rejected: 0, lowInfo: 0, invalidations: [] };
  const repoPath = opts.repoPath ?? ctx.infra.machine.cwd;
  const git = opts.git ?? ctx.infra.machine.git;
  if (repoPath === undefined || !isGitRepo(git, repoPath)) return { status: 'not-a-repo', ...none };
  const gitLog = fetchGitLog(git, repoPath, opts.days);
  if (!gitLog.trim()) return { status: 'no-commits', ...none };
  const config = ctx.config;
  const parsed = extractLessons(gitLog, config.gitLearnPatterns);
  if (parsed.length === 0) return { status: 'no-lessons', ...none };
  // The gate filters the loop input, so a dropped lesson neither stores nor invalidates;
  // docs/decisions git-learn-gate-placement says why.
  const { kept, dropped } = partitionLessons(parsed);
  return {
    status: 'scanned',
    lowInfo: dropped.length,
    ...(await writeLessons(ctx, kept, { ...opts, repoPath }, config)),
  };
}

interface QueuedLesson {
  entry: MemoryEntry;
  key: string;
}

/** Where a batch writes and what it has learned so far: `live` and `keys` follow every write, so
 * a later lesson matches against them. */
interface LessonBatch {
  readonly ctx: LearnContext;
  readonly writes: LessonWrites;
  readonly live: MemoryEntry[];
  readonly keys: Set<string>;
  readonly counts: LessonCounts;
  readonly full: boolean;
}

/** Writes `queued` in one transaction; a refused lesson is dropped from `live` and `keys` and
 * must not abort the rest of the git-log scan. */
async function landLessons(batch: LessonBatch, queued: readonly QueuedLesson[]): Promise<void> {
  if (queued.length === 0) return;
  const { ctx, writes, live, keys, counts } = batch;
  const written = new Set(
    await writes.writeSkippingRejected(
      queued.map((q) => q.entry),
      ctx.actor.subject,
    ),
  );
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
  if (landed.length > 0) await ctx.store.hippoDb.stats.bumpRemembered(landed.length);
  const { embedderFor, clock, failureNotices } = ctx.infra;
  const { store, config } = ctx;
  const target = {
    groups: { vectors: store.vectors, vectorWrites: store.vectorWrites },
    embeddings: config.embeddings,
    embedderFor,
    failureNotices,
    strength: strengthOf(ctx),
    clock,
  };
  await withDetached(ctx, (detached) => {
    for (const entry of landed) embedMemoryDetached(target, entry, detached);
  });
}

/** The keys of the rows that may hold a lesson, the only rows that can be its copy. */
async function knownKeys(
  ctx: Context,
  writes: LessonWrites,
  lessons: readonly string[],
): Promise<Set<string>> {
  const held = await writes.textsHolding(ctx.tenantId, lessons, personalScopeOf(ctx.actor));
  return storedTextKeys(held);
}

interface LessonMemoryInputs {
  readonly tenantId: string;
  readonly config: HippoConfig;
  readonly fitSource: SchemaFitSource | undefined;
  readonly pathTags: readonly string[];
  readonly now: Date;
}

function newLessonMemory(
  lesson: string,
  profile: LearnProfile,
  inputs: LessonMemoryInputs,
): MemoryEntry {
  const { tenantId, config, fitSource, pathTags, now } = inputs;
  const entry = createMemory(
    lesson,
    {
      layer: Layer.Episodic,
      tags: [...profile.tags],
      source: profile.source,
      confidence: 'observed',
      schemaFit: fitSource && schemaFitFrom(lesson, [...profile.tags], fitSource),
      tenantId,
      baseHalfLifeDays: config.defaultHalfLifeDays,
    },
    now,
  );
  for (const tag of pathTags) if (!entry.tags.includes(tag)) entry.tags.push(tag);
  return entry;
}

interface TenantScan {
  /** The rows a lesson's migration target can weaken; every lesson written this batch joins
   * them. */
  readonly live: MemoryEntry[];
  readonly fitSource: SchemaFitSource;
  /** Duplicate keys of what the caller can read. */
  readonly keys: Set<string>;
}

/** One pass over the tenant in pages: keeps the rows `targets` match, and from the rows the
 * caller can read only the tag counts, texts and duplicate keys that scoring a lesson needs. */
async function scanTenant(
  ctx: Context,
  targets: readonly InvalidationTarget[],
  pageRows: number,
): Promise<TenantScan> {
  const matches = invalidationMatcher(targets);
  const live: MemoryEntry[] = [];
  const tagCounts = new Map<string, number>();
  const contents: string[] = [];
  const keys = new Set<string>();
  for await (const page of memoryPages(ctx.store, ctx.tenantId, pageRows)) {
    for (const entry of page) {
      if (matches(entry)) live.push(entry);
      // Learn is host-admin only, so it reads what an admin can.
      if (entry.scope != null && !canReadScope(ctx.actor, entry.scope)) continue;
      for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      contents.push(entry.content);
      for (const key of heldTextKeys(entry)) keys.add(key);
    }
  }
  return { live, fitSource: { rows: contents.length, tagCounts, contents }, keys };
}

async function writeLessons(
  ctx: LearnContext,
  lessons: readonly string[],
  opts: LearnOptions & { readonly repoPath: string },
  config: HippoConfig,
): Promise<LessonCounts> {
  const { tenantId } = ctx;
  const { profile } = opts;
  const { batch, fitSource } = await openLessonBatch(ctx, lessons, opts);
  const pathTags = profile.full ? extractPathTags(opts.repoPath) : [];
  // Lessons queue and land in one transaction; an invalidation reads the store, so it flushes the
  // queue first.
  const queue: QueuedLesson[] = [];
  for (const lesson of lessons) {
    const key = duplicateKey(lesson);
    if (batch.keys.has(key)) {
      batch.counts.skipped++;
      continue;
    }
    const target = profile.full ? extractInvalidationTarget(lesson) : null;
    if (target) await invalidateAfterLanding(batch, queue, target);
    const entry = newLessonMemory(lesson, profile, {
      tenantId,
      config,
      fitSource,
      pathTags,
      now: ctx.infra.clock(),
    });
    queue.push({ entry, key });
    if (profile.full) batch.live.push(entry);
    batch.keys.add(key);
  }
  await landLessons(batch, queue.splice(0));
  return batch.counts;
}

interface OpenedLessonBatch {
  readonly batch: LessonBatch;
  readonly fitSource: SchemaFitSource | undefined;
}

async function openLessonBatch(
  ctx: LearnContext,
  lessons: readonly string[],
  opts: LearnOptions,
): Promise<OpenedLessonBatch> {
  const { profile } = opts;
  const writes = ctx.store.hippoDb.lessonWrites;
  // One pass serves the batch: invalidation matches against `live`, which follows every write
  // below. Schema fit needs every readable row, and each lesson is scored against them as they were
  // before the batch.
  const targets = profile.full
    ? lessons.flatMap((lesson) => extractInvalidationTarget(lesson) ?? [])
    : [];
  const scan = profile.full
    ? await scanTenant(ctx, targets, opts.pageRows ?? TENANT_PAGE_ROWS)
    : undefined;
  const live = scan?.live ?? [];
  const fitSource = scan?.fitSource;
  const batch: LessonBatch = {
    ctx,
    writes,
    live,
    keys: scan?.keys ?? (await knownKeys(ctx, writes, lessons)),
    full: profile.full,
    counts: { added: 0, skipped: 0, rejected: 0, invalidations: [] },
  };
  return { batch, fitSource };
}

async function invalidateAfterLanding(
  batch: LessonBatch,
  queue: QueuedLesson[],
  target: InvalidationTarget,
): Promise<void> {
  const { store, tenantId } = batch.ctx;
  await landLessons(batch, queue.splice(0));
  const { invalidated } = await invalidateMatchingAmong(store, batch.live, target, tenantId);
  if (invalidated > 0) {
    batch.counts.invalidations.push({ from: target.from, count: invalidated });
  }
}

export type { InvalidationOptions, InvalidationResult, InvalidationTarget };

/** `hippo invalidate`: weakens the caller's tenant's memories that reference `target.from`, or
 * only the one `options.onlyId` names. */
export async function memoryInvalidate(
  ctx: ContextWith<'learning' | 'lessonWrites'>,
  target: InvalidationTarget,
  options: InvalidationOptions,
): Promise<InvalidationResult> {
  return invalidateMatching(ctx.store, target, ctx.tenantId, options);
}
