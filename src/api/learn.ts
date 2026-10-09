// Git auto-learn: fix/revert/bug commit subjects become memories. `hippo learn`, init, sleep and MCP hippo_learn share it.

import { ForbiddenError } from '../api-errors.js';
import { fetchGitLog, extractLessons, partitionLessons, isGitRepo } from '../autolearn.js';
import { type HippoConfig, loadConfig } from '../config.js';
import { embedMemory } from '../embeddings.js';
import { extractInvalidationTarget, invalidateMatching } from '../invalidation.js';
import { StoreNotPortedError } from '../db/sqlite-blocked.js';
import { computeSchemaFit, createMemory, Layer, type MemoryEntry } from '../memory.js';
import { extractPathTags } from '../path-context.js';
import { canReadScope, personalScopeOf, touchableScopeSql } from '../recall-scope.js';
import { RejectedValueError } from '../rejection.js';
import { duplicateKey, longestWord, storedTextKeys } from '../same-text.js';
import { requireGroup, type HippoStore } from '../store-port.js';
import { loadTextsHoldingWords } from '../store/candidates.js';
import { stampOriginProject } from '../store/entry-row.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { writeEntry } from '../store/entry-writes.js';
import { updateStats } from '../store/index-and-stats.js';
import type { Context, StoreReply } from './types.js';

/** How a surface writes what it learns. */
export interface LearnProfile {
  readonly tags: readonly string[];
  readonly source: string;
  /** Also invalidate what a migration subject supersedes, score schema fit, path-tag, count and embed each row. */
  readonly full: boolean;
}

// SHORTCUT: two profiles keep each surface's rows as they were; fold MCP onto the CLI profile once it may invalidate.
export const CLI_LEARN: LearnProfile = Object.freeze({ tags: Object.freeze(['error', 'git-learned']), source: 'git-learn', full: true });
export const MCP_LEARN: LearnProfile = Object.freeze({ tags: Object.freeze(['git-learned']), source: 'git', full: false });

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

type LessonScan = { readonly done: LearnResult } | { readonly kept: readonly string[]; readonly lowInfo: number; readonly config: HippoConfig };

/** Learn from `repoPath`'s last `days` of commits into the caller's tenant. Host admin only. With `ctx.store`, only the MCP profile, through its hooks and entryWrites groups. */
export function learn<C extends Context>(ctx: C, opts: LearnOpts): StoreReply<C, LearnResult> {
  const reply = ctx.store ? learnThroughStore({ ...ctx, store: ctx.store }, opts) : learnOnHippoDb(ctx, opts);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, LearnResult>;
}

function scanLessons(ctx: Context, opts: LearnOpts): LessonScan {
  // It reads the host's own git history, which belongs to the host, not to the caller's tenant.
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('hippo_learn requires a host admin');
  const none = { added: 0, skipped: 0, rejected: 0, lowInfo: 0, invalidations: [] };
  if (!isGitRepo(opts.repoPath)) return { done: { status: 'not-a-repo', ...none } };
  const gitLog = fetchGitLog(opts.repoPath, opts.days);
  if (!gitLog.trim()) return { done: { status: 'no-commits', ...none } };
  const config = loadConfig(ctx.hippoRoot);
  const parsed = extractLessons(gitLog, config.gitLearnPatterns);
  if (parsed.length === 0) return { done: { status: 'no-lessons', ...none } };
  // The gate filters the loop input, so a dropped lesson neither stores nor invalidates; docs/decisions git-learn-gate-placement says why.
  const { kept, dropped } = partitionLessons(parsed);
  return { kept, lowInfo: dropped.length, config };
}

function learnOnHippoDb(ctx: Context, opts: LearnOpts): LearnResult {
  const scan = scanLessons(ctx, opts);
  if ('done' in scan) return scan.done;
  return { status: 'scanned', lowInfo: scan.lowInfo, ...writeLessons(ctx, scan.kept, opts, scan.config) };
}

async function learnThroughStore(ctx: Context & { readonly store: HippoStore }, opts: LearnOpts): Promise<LearnResult> {
  const hooks = requireGroup(ctx.store, 'hooks');
  const entryWrites = requireGroup(ctx.store, 'entryWrites');
  // Invalidation, schema fit and embedding read and write hippo.db; only the CLI uses them.
  if (opts.profile.full) throw new StoreNotPortedError(ctx.store.kind, 'cli learn profile');
  const scan = scanLessons(ctx, opts);
  if ('done' in scan) return scan.done;
  const held = await hooks.textsHoldingWords({
    tenantId: ctx.tenantId, words: scan.kept.map(longestWord), reach: { kind: 'touchable', ownScope: personalScopeOf(ctx.actor) },
  });
  const keys = storedTextKeys(held);
  const counts: LessonCounts = { added: 0, skipped: 0, rejected: 0, invalidations: [] };
  for (const lesson of scan.kept) {
    if (keys.has(duplicateKey(lesson))) { counts.skipped++; continue; }
    const entry = stampOriginProject(ctx.hippoRoot, lessonMemory(ctx.tenantId, lesson, opts.profile, scan.config, undefined));
    try {
      await entryWrites.writeEntry({ entry, actor: ctx.actor.subject });
    } catch (err) {
      if (err instanceof RejectedValueError) { counts.rejected++; continue; }
      throw err;
    }
    keys.add(duplicateKey(lesson));
    counts.added++;
  }
  return { status: 'scanned', lowInfo: scan.lowInfo, ...counts };
}

function lessonMemory(tenantId: string, lesson: string, profile: LearnProfile, config: HippoConfig, existing: MemoryEntry[] | undefined): MemoryEntry {
  return createMemory(lesson, {
    layer: Layer.Episodic,
    tags: [...profile.tags],
    source: profile.source,
    confidence: 'observed',
    schema_fit: existing && computeSchemaFit(lesson, [...profile.tags], existing),
    tenantId,
    baseHalfLifeDays: config.defaultHalfLifeDays,
  });
}

function writeLessons(ctx: Context, lessons: readonly string[], opts: LearnOpts, config: HippoConfig): LessonCounts {
  const { hippoRoot, tenantId } = ctx;
  const { profile } = opts;
  // Schema fit needs every row; without it, only rows holding a lesson's longest word can be its copy. Learn is host-admin only, so both read what an admin can.
  const existing = profile.full ? loadAllEntries(hippoRoot, tenantId).filter((e) => e.scope == null || canReadScope(ctx.actor, e.scope)) : undefined;
  const readable = touchableScopeSql('', personalScopeOf(ctx.actor));
  const keys = storedTextKeys(existing ?? loadTextsHoldingWords(hippoRoot, tenantId, lessons.map(longestWord), undefined, readable));
  const pathTags = profile.full ? extractPathTags(opts.repoPath) : [];
  const counts: LessonCounts = { added: 0, skipped: 0, rejected: 0, invalidations: [] };
  for (const lesson of lessons) {
    if (keys.has(duplicateKey(lesson))) { counts.skipped++; continue; }
    const target = profile.full ? extractInvalidationTarget(lesson) : null;
    if (target) {
      const { invalidated } = invalidateMatching(hippoRoot, target, tenantId);
      if (invalidated > 0) counts.invalidations.push({ from: target.from, count: invalidated });
    }
    const entry = lessonMemory(tenantId, lesson, profile, config, existing);
    for (const tag of pathTags) if (!entry.tags.includes(tag)) entry.tags.push(tag);
    // A refused lesson must not abort the rest of the git-log scan.
    try {
      writeEntry(hippoRoot, entry, { actor: ctx.actor.subject });
    } catch (err) {
      if (err instanceof RejectedValueError) { counts.rejected++; continue; }
      throw err;
    }
    if (profile.full) updateStats(hippoRoot, { remembered: 1 });
    keys.add(duplicateKey(lesson));
    if (profile.full) void embedMemory(hippoRoot, entry);
    counts.added++;
  }
  return counts;
}
