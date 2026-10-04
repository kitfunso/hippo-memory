// Write-side tool handlers: hippo_remember, hippo_outcome and hippo_learn.

import { log } from '../log.js';
import { createMemory, Layer } from '../memory.js';
import { writeEntry } from '../store/entry-writes.js';
import { readEntry } from '../store/entry-reads.js';
import { loadTextsHoldingWords } from '../store/candidates.js';
import { countCreatedSinceLastSleep } from '../store/index-and-stats.js';
import { consolidate } from '../consolidate/sleep.js';
import { fetchGitLog, extractLessons, partitionLessons, isGitRepo } from '../autolearn.js';
import { duplicateKey, longestWord, storedTextKeys } from '../same-text.js';
import { resolveTenantId } from '../tenant.js';
import { ForbiddenError } from '../api-errors.js';
import { remember as apiRemember, outcome as apiOutcome, type Context as ApiContext } from '../api.js';
import { RejectedValueError } from '../rejection.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { lastRecalledIds, autoSleepInFlight, resolveClientKey } from './session-state.js';

export function runRememberTool({ args, ctx, hippoRoot, config, tenantId }: ToolCall): string {
  const text = String(args.text || '');
  if (!text) return 'No text provided.';
  const tags: string[] = [];
  if (args.error) tags.push('error');
  if (args.tag) tags.push(String(args.tag));
  // Route through api.ts so audit_log captures the caller identity
  // uniformly with CLI/REST: the auth-resolved ctx.actor under HTTP-MCP,
  // 'mcp' for stdio (no ctx). api.ts.remember writes the memory + audit
  // row in one transaction-friendly path; we re-read the entry to surface
  // the half-life used in the MCP human-readable response.
  const apiCtx: ApiContext = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
  };
  const result = apiRemember(apiCtx, {
    content: text,
    tags,
  });
  const entry = readEntry(hippoRoot, result.id, tenantId);

  // Auto-sleep: one run per store at a time, triggered by what arrived since the last one.
  // Consolidation is host-wide, so only the host tenant's writes may start it.
  if (
    config.autoSleep.enabled &&
    tenantId === resolveTenantId({}) &&
    !autoSleepInFlight.has(hippoRoot) &&
    countCreatedSinceLastSleep(hippoRoot, tenantId) >= config.autoSleep.threshold
  ) {
    autoSleepInFlight.add(hippoRoot);
    // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so log it.
    consolidate(hippoRoot)
      .catch((err) => {
        log.error(`auto-sleep consolidate failed (tenant ${tenantId}): ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => autoSleepInFlight.delete(hippoRoot));
  }

  const halfLife = entry?.half_life_days ?? config.defaultHalfLifeDays;
  const tagStr = entry?.tags.join(', ') || tags.join(', ') || 'none';
  const warnings = (result.warnings ?? []).map((w) => `\nWarning: ${w}`).join('');
  return `Remembered [${result.id}] (half-life: ${halfLife}d, tags: ${tagStr})${warnings}`;
}

export function runOutcomeTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const good = Boolean(args.good);
  const clientKey = resolveClientKey(ctx);
  const ids = lastRecalledIds.get(clientKey) ?? [];
  if (ids.length === 0) return 'No recent recalls to apply outcome to.';

  // Route through src/api.ts so audit_log captures the caller identity
  // (auth-resolved ctx.actor under HTTP-MCP, 'mcp' for stdio) and tenant
  // scoping is enforced uniformly (same surface as recall/remember).
  // outcome() also handles cross-tenant id skip silently.
  const apiCtx: ApiContext = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
  };
  const { applied } = apiOutcome(apiCtx, ids, good);
  return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
}

export function runLearnTool({ args, ctx, hippoRoot, config, tenantId }: ToolCall): string {
  // It reads the server's own git history, which belongs to the host, not to the caller's tenant.
  if (!mcpActor(ctx).hostAdmin) throw new ForbiddenError('hippo_learn requires a host admin');
  const days = Number(args.days) || 7;
  if (!isGitRepo(process.cwd())) return 'No git history found.';
  const gitLog = fetchGitLog(process.cwd(), days);
  if (!gitLog.trim()) return 'No fix/revert/bug commits found in the specified period.';
  const parsedLessons = extractLessons(gitLog, config.gitLearnPatterns);
  // DF4: admission gate lives at the write path, not in extractLessons
  // (a published API surface that only parses). Bare subjects like
  // "fixed signals" are dropped here, before they ever become a memory.
  // Gating the loop INPUT is correct here, unlike the CLI path: this
  // loop only writes. The CLI's loop also runs invalidation, so there
  // the gate has to sit on the write alone or a migration subject stops
  // superseding stale memories. Same predicate, different placement,
  // because the loops do different work.
  const { kept: lessons, dropped } = partitionLessons(parsedLessons);
  const lowInfo = dropped.length;
  let added = 0;
  let skipped = 0;
  let rejected = 0;
  const keys = storedTextKeys(loadTextsHoldingWords(hippoRoot, tenantId, lessons.map(longestWord)));
  for (const lesson of lessons) {
    if (keys.has(duplicateKey(lesson))) { skipped++; continue; }
    const entry = createMemory(lesson, {
      layer: Layer.Episodic,
      tags: ['git-learned'],
      source: 'git',
      confidence: 'observed',
      baseHalfLifeDays: config.defaultHalfLifeDays,
      tenantId,
    });
    // AT1 (plan §3 containment): a refused lesson must not crash the
    // MCP learn call or lose the rest of the git log scan.
    try {
      writeEntry(hippoRoot, entry, { actor: ctx?.actor ?? 'mcp' });
    } catch (err) {
      if (err instanceof RejectedValueError) { rejected++; continue; }
      throw err;
    }
    keys.add(duplicateKey(lesson));
    added++;
  }
  const rejectedSuffix = rejected > 0 ? `, ${rejected} rejected values skipped` : '';
  const lowInfoSuffix = lowInfo > 0 ? `, ${lowInfo} low-information subjects dropped` : '';
  return `Git learn: ${added} new, ${skipped} duplicates skipped${rejectedSuffix}${lowInfoSuffix} (scanned ${days} days)`;
}
