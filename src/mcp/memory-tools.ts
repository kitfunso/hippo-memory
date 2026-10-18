// Write-side tool handlers: hippo_remember, hippo_outcome and hippo_learn.

import { hasGroup } from '../store/index.js';
import { resolveTenantId } from '../store/tenant.js';
import { startAutoSleepIfDue } from '../api/sleep/auto-sleep.js';
import { remember as apiRemember, outcome as apiOutcome, learn as apiLearn, MCP_LEARN } from '../api/index.js';
import { mcpApiContext, type ToolCall } from './protocol.js';
import { lastRecalledIds, resolveClientKey } from '../api/recall/last-recalled.js';

export async function runRememberTool({ args, ctx, hippoRoot, config, tenantId, store }: ToolCall): Promise<string> {
  const text = String(args.text || '');
  if (!text) return 'No text provided.';
  const tags: string[] = [];
  if (args.error) tags.push('error');
  if (args.tag) tags.push(String(args.tag));
  // Route through api/index.ts so audit_log captures the caller identity like CLI/REST: the auth-resolved ctx.actor
  // under HTTP-MCP, 'mcp' for stdio.
  const result = await apiRemember(mcpApiContext(ctx), {
    content: text,
    tags,
    personal: args.personal === true,
    project: ctx?.project,
  });

  // Auto-sleep runs on hippo.db, so another store skips it.
  const allowed = hasGroup(store, 'localFiles') && ctx.autoSleep !== false;
  const run = ctx.autoSleepRunner;
  const gate = { hippoRoot, tenantId, hostTenantId: resolveTenantId({}), config: config.autoSleep, allowed };
  if (run !== undefined) await startAutoSleepIfDue(store, gate, run);

  const tagStr = result.tags.join(', ') || 'none';
  const warnings = (result.warnings ?? []).map((w) => `\nWarning: ${w}`).join('');
  return `Remembered [${result.id}] (half-life: ${result.halfLifeDays}d, tags: ${tagStr})${warnings}`;
}

export async function runOutcomeTool({ args, ctx }: ToolCall): Promise<string> {
  const good = Boolean(args.good);
  const clientKey = resolveClientKey(ctx);
  const ids = lastRecalledIds.get(clientKey) ?? [];
  if (ids.length === 0) return 'No recent recalls to apply outcome to.';

  // Route through src/api/index.ts so audit_log captures the caller identity (auth-resolved ctx.actor under HTTP-MCP,
  // 'mcp' for stdio) and tenant scoping is uniform; outcome() also skips cross-tenant ids silently.
  const { applied } = await apiOutcome(mcpApiContext(ctx), ids, good);
  return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
}

export async function runLearnTool({ args, ctx }: ToolCall): Promise<string> {
  const days = Number(args.days) || 7;
  // process.cwd() is the server's repo, not a remote caller's, so api learn refuses all but stdio and a host admin
  // (mcpActor fails closed).
  const result = await apiLearn(mcpApiContext(ctx), { repoPath: process.cwd(), days, profile: MCP_LEARN });
  if (result.status === 'not-a-repo') return 'No git history found.';
  if (result.status === 'no-commits') return 'No fix/revert/bug commits found in the specified period.';
  const { added, skipped, rejected, lowInfo } = result;
  const rejectedSuffix = rejected > 0 ? `, ${rejected} rejected values skipped` : '';
  const lowInfoSuffix = lowInfo > 0 ? `, ${lowInfo} low-information subjects dropped` : '';
  return `Git learn: ${added} new, ${skipped} duplicates skipped${rejectedSuffix}${lowInfoSuffix} (scanned ${days} days)`;
}
