// Write-side tool handlers: hippo_remember, hippo_outcome and hippo_learn.

import { storeFor } from '../store-port.js';
import { startAutoSleepIfDue } from '../api/auto-sleep.js';
import { remember as apiRemember, outcome as apiOutcome, learn as apiLearn, MCP_LEARN, type Context as ApiContext } from '../api.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { lastRecalledIds, resolveClientKey } from './session-state.js';

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

  // Auto-sleep runs on hippo.db, so another store skips it.
  startAutoSleepIfDue(hippoRoot, tenantId, config.autoSleep, (ctx?.store === undefined || ctx.store.kind === 'sqlite') && ctx?.autoSleep !== false);

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
