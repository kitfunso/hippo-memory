// Write-side tool handlers: hippo_remember, hippo_outcome and hippo_learn.

import { log } from '../log.js';
import { storeFor } from '../store-port.js';
import { countCreatedSinceLastSleep } from '../store/index-and-stats.js';
import { consolidate } from '../consolidate/sleep.js';
import { outsideRequestStores, runWithRequestStores, scopedBusyWait } from '../db.js';
import { resolveTenantId } from '../tenant.js';
import { remember as apiRemember, outcome as apiOutcome, learn as apiLearn, MCP_LEARN, type Context as ApiContext } from '../api.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { lastRecalledIds, autoSleepInFlight, resolveClientKey } from './session-state.js';

export async function runRememberTool({ args, ctx, hippoRoot, config, tenantId }: ToolCall): Promise<string> {
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
    store: ctx?.store,
  };
  const result = await apiRemember(apiCtx, {
    content: text,
    tags,
    personal: args.personal === true,
    project: ctx?.project,
  });
  const [entry] = await storeFor(apiCtx).entriesByIds([result.id], tenantId);

  // Auto-sleep: one run per store at a time, triggered by what arrived since the last one.
  // Consolidation is host-wide, so only the host tenant's writes may start it. It runs on hippo.db, so another store skips it.
  if (
    (ctx?.store === undefined || ctx.store.kind === 'sqlite') &&
    ctx?.autoSleep !== false &&
    config.autoSleep.enabled &&
    tenantId === resolveTenantId({}) &&
    !autoSleepInFlight.has(hippoRoot) &&
    countCreatedSinceLastSleep(hippoRoot, tenantId) >= config.autoSleep.threshold
  ) {
    autoSleepInFlight.add(hippoRoot);
    // Fire-and-forget (never block the response); an unhandled rejection would kill the server, so log it.
    // Its own scope: the call's closes a handle the sleep still holds across its pauses, but the caller's lock wait carries over.
    const busyWaitMs = scopedBusyWait();
    outsideRequestStores(() => runWithRequestStores(() => consolidate(hippoRoot), { busyWaitMs }))
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

export async function runOutcomeTool({ args, ctx, hippoRoot, tenantId }: ToolCall): Promise<string> {
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
    store: ctx?.store,
  };
  const { applied } = await apiOutcome(apiCtx, ids, good);
  return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
}

export function runLearnTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const days = Number(args.days) || 7;
  const result = apiLearn({ hippoRoot, tenantId, actor: mcpActor(ctx), store: ctx?.store }, { repoPath: process.cwd(), days, profile: MCP_LEARN });
  if (result.status === 'not-a-repo') return 'No git history found.';
  if (result.status === 'no-commits') return 'No fix/revert/bug commits found in the specified period.';
  const { added, skipped, rejected, lowInfo } = result;
  const rejectedSuffix = rejected > 0 ? `, ${rejected} rejected values skipped` : '';
  const lowInfoSuffix = lowInfo > 0 ? `, ${lowInfo} low-information subjects dropped` : '';
  return `Git learn: ${added} new, ${skipped} duplicates skipped${rejectedSuffix}${lowInfoSuffix} (scanned ${days} days)`;
}
