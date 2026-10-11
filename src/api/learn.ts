// Git auto-learn: fix/revert/bug commit subjects become memories. `hippo learn`, init, sleep and MCP hippo_learn share it.

import { ForbiddenError } from '../core/api-errors.js';
import { fetchGitLog, extractLessons, partitionLessons, isGitRepo } from '../learn/autolearn.js';
import { type HippoConfig, loadConfig } from '../core/config.js';
import { withRequestStoresSync } from '../db/request-stores.js';
import { embedMemory } from '../store/embeddings/index.js';
import { extractInvalidationTarget, invalidateMatchingAmong } from '../learn/invalidation.js';
import { computeSchemaFit, createMemory, Layer } from '../core/memory.js';
import { extractPathTags } from '../search/path-context.js';
import { canReadScope, personalScopeOf } from '../core/recall-scope.js';
import { touchableScopeSql } from '../store/rule-sql.js';
import { RejectedValueError } from '../core/api-errors.js';
import { duplicateKey, longestWord, storedTextKeys } from '../util/same-text.js';
import { loadTextsHoldingWords } from '../store/candidates.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { writeEntry } from '../store/entry-writes.js';
import { updateStats } from '../store/index-and-stats.js';
import type { Context } from './types.js';

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

/** Learn from `repoPath`'s last `days` of commits into the caller's tenant. Host admin only. */
export function learn(ctx: Context, opts: LearnOpts): LearnResult {
  // It reads the host's own git history, which belongs to the host, not to the caller's tenant.
  if (!ctx.actor.hostAdmin) throw new ForbiddenError('hippo_learn requires a host admin');
  const none = { added: 0, skipped: 0, rejected: 0, lowInfo: 0, invalidations: [] };
  if (!isGitRepo(opts.repoPath)) return { status: 'not-a-repo', ...none };
  const gitLog = fetchGitLog(opts.repoPath, opts.days);
  if (!gitLog.trim()) return { status: 'no-commits', ...none };
  const config = loadConfig(ctx.hippoRoot);
  const parsed = extractLessons(gitLog, config.gitLearnPatterns);
  if (parsed.length === 0) return { status: 'no-lessons', ...none };
  // The gate filters the loop input, so a dropped lesson neither stores nor invalidates; docs/decisions git-learn-gate-placement says why.
  const { kept, dropped } = partitionLessons(parsed);
  return { status: 'scanned', lowInfo: dropped.length, ...writeLessons(ctx, kept, opts, config) };
}

function writeLessons(ctx: Context, lessons: readonly string[], opts: LearnOpts, config: HippoConfig): LessonCounts {
  const { hippoRoot, tenantId } = ctx;
  const { profile } = opts;
  // `hippo init` calls this outside any request, so the batch brings its own scope: every read and write below shares one handle.
  return withRequestStoresSync(() => {
    // One read serves the batch: invalidation matches against `live`, which follows every write below, as a reload per lesson did.
    const live = profile.full ? loadAllEntries(hippoRoot, tenantId) : [];
    // Schema fit needs every row; without it, only rows holding a lesson's longest word can be its copy. Learn is host-admin only, so
    // both read what an admin can.
    const existing = profile.full ? live.filter((e) => e.scope == null || canReadScope(ctx.actor, e.scope)) : undefined;
    const readable = touchableScopeSql('', personalScopeOf(ctx.actor));
    const keys = storedTextKeys(existing ?? loadTextsHoldingWords(hippoRoot, tenantId, lessons.map(longestWord), undefined, readable));
    const pathTags = profile.full ? extractPathTags(opts.repoPath) : [];
    const counts: LessonCounts = { added: 0, skipped: 0, rejected: 0, invalidations: [] };
    for (const lesson of lessons) {
      if (keys.has(duplicateKey(lesson))) { counts.skipped++; continue; }
      const target = profile.full ? extractInvalidationTarget(lesson) : null;
      if (target) {
        const { invalidated } = invalidateMatchingAmong(hippoRoot, live, target, tenantId);
        if (invalidated > 0) counts.invalidations.push({ from: target.from, count: invalidated });
      }
      const entry = createMemory(lesson, {
        layer: Layer.Episodic,
        tags: [...profile.tags],
        source: profile.source,
        confidence: 'observed',
        schema_fit: existing && computeSchemaFit(lesson, [...profile.tags], existing),
        tenantId,
        baseHalfLifeDays: config.defaultHalfLifeDays,
      });
      for (const tag of pathTags) if (!entry.tags.includes(tag)) entry.tags.push(tag);
      // A refused lesson must not abort the rest of the git-log scan.
      try {
        writeEntry(hippoRoot, entry, { actor: ctx.actor.subject });
      } catch (err) {
        if (err instanceof RejectedValueError) { counts.rejected++; continue; }
        throw err;
      }
      if (profile.full) {
        updateStats(hippoRoot, { remembered: 1 });
        live.push(entry);
      }
      keys.add(duplicateKey(lesson));
      if (profile.full) void embedMemory(hippoRoot, entry);
      counts.added++;
    }
    return counts;
  });
}
