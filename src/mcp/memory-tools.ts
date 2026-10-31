// Write-side tool handlers: hippo_remember, hippo_outcome and hippo_learn.

import { hasGroup } from '../store/index.js';
import { startAutoSleepIfDue } from '../api/sleep/auto-sleep.js';
import {
  remember as apiRemember,
  outcome as apiOutcome,
  learn as apiLearn,
  MCP_LEARN,
  type ContextWith,
} from '../api/index.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { lastRecalledIds, resolveClientKey } from './session-state.js';

export async function runRememberTool(
  { args, ctx, hippoRoot, config, tenantId, store }: ToolCall<'entryWrites'>
): Promise<string> {
  const text = String(args.text || '');
  if (!text) return 'No text provided.';
  const tags: string[] = [];
  if (args.error) tags.push('error');
  if (args.tag) tags.push(String(args.tag));
  // Route through api/index.ts so audit_log captures the caller identity like CLI/REST: the auth-resolved ctx.actor
  // under HTTP-MCP, 'mcp' for stdio.
  const apiCtx: ContextWith<'entryWrites'> = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
    store,
  };
  const result = await apiRemember(apiCtx, {
    content: text,
    tags,
    personal: args.personal === true,
    project: ctx?.project,
  });

  // Auto-sleep runs on hippo.db, so another store skips it.
  const allowed = hasGroup(store, 'localFiles') && ctx.autoSleep !== false;
  const run = ctx.autoSleepRunner;
  if (run !== undefined) startAutoSleepIfDue(hippoRoot, tenantId, config.autoSleep, allowed, run);

  const tagStr = result.tags.join(', ') || 'none';
  const warnings = (result.warnings ?? []).map((w) => `\nWarning: ${w}`).join('');
  return `Remembered [${result.id}] (half-life: ${result.halfLifeDays}d, tags: ${tagStr})${warnings}`;
}

export async function runOutcomeTool(
  { args, ctx, hippoRoot, tenantId, store }: ToolCall<'entryWrites'>
): Promise<string> {
  const good = Boolean(args.good);
  const clientKey = resolveClientKey(ctx);
  const ids = lastRecalledIds.get(clientKey) ?? [];
  if (ids.length === 0) return 'No recent recalls to apply outcome to.';

  // Route through src/api/index.ts so audit_log captures the caller identity (auth-resolved ctx.actor under HTTP-MCP,
  // 'mcp' for stdio) and tenant scoping is uniform; outcome() also skips cross-tenant ids silently.
  const apiCtx: ContextWith<'entryWrites'> = {
    hippoRoot,
    tenantId,
    actor: mcpActor(ctx),
    store,
  };
  const { applied } = await apiOutcome(apiCtx, ids, good);
  return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
}

export async function runLearnTool(
  { args, ctx, hippoRoot, tenantId, store }: ToolCall<'lessonWrites'>
): Promise<string> {
  const days = Number(args.days) || 7;
  // process.cwd() is the server's repo, not a remote caller's, so api learn refuses all but stdio and a host admin
  // (mcpActor fails closed).
  const result = await apiLearn(
    { hippoRoot, tenantId, actor: mcpActor(ctx), store },
    { repoPath: process.cwd(), days, profile: MCP_LEARN },
  );
  if (result.status === 'not-a-repo') return 'No git history found.';
  if (result.status === 'no-commits') return 'No fix/revert/bug commits found in the specified period.';
  const { added, skipped, rejected, lowInfo } = result;
  const rejectedSuffix = rejected > 0 ? `, ${rejected} rejected values skipped` : '';
  const lowInfoSuffix = lowInfo > 0 ? `, ${lowInfo} low-information subjects dropped` : '';
  return `Git learn: ${added} new, ${skipped} duplicates skipped${rejectedSuffix}${lowInfoSuffix} (scanned ${days} days)`;
}
