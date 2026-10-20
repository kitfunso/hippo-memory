// Write-side tool handlers: hippo_remember, hippo_outcome and hippo_learn.

import { remember as apiRemember, outcome as apiOutcome, learn as apiLearn, MCP_LEARN } from '../../api/index.js';
import { processGit } from '../../base/util/git-runner.js';
import { mcpApiContext, type ToolCall } from './protocol.js';
import { resolveClientKey } from '../../api/recall/last-recalled.js';
import { DEFAULT_LEARN_DAYS, MAX_CONTENT_LEN, MAX_ID_LEN } from '../../base/util/limits.js';
import { boolArg, numberArg, stringArg } from './tool-args.js';

export async function runRememberTool({ args, ctx }: ToolCall): Promise<string> {
  const text = stringArg(args, 'text', MAX_CONTENT_LEN);
  if (!text) return 'No text provided.';
  const tags: string[] = [];
  if (boolArg(args, 'error')) tags.push('error');
  const tag = stringArg(args, 'tag', MAX_ID_LEN);
  if (tag) tags.push(tag);
  // Route through api/index.ts so audit_log captures the caller identity like CLI/REST: the auth-resolved ctx.actor
  // under HTTP-MCP, 'mcp' for stdio. It also starts the root's auto-sleep when one is due.
  const result = await apiRemember(mcpApiContext(ctx), {
    content: text,
    tags,
    personal: boolArg(args, 'personal'),
    project: ctx?.project,
  });

  const tagStr = result.tags.join(', ') || 'none';
  const warnings = (result.warnings ?? []).map((w) => `\nWarning: ${w}`).join('');
  return `Remembered [${result.id}] (half-life: ${result.halfLifeDays}d, tags: ${tagStr})${warnings}`;
}

export async function runOutcomeTool({ args, ctx }: ToolCall): Promise<string> {
  const good = boolArg(args, 'good');
  const clientKey = resolveClientKey(ctx);
  const ids = ctx.callers?.lastShown.get(clientKey) ?? [];
  if (ids.length === 0) return 'No recent recalls to apply outcome to.';

  // Route through src/api/index.ts so audit_log captures the caller identity (auth-resolved ctx.actor under HTTP-MCP,
  // 'mcp' for stdio) and tenant scoping is uniform; outcome() also skips cross-tenant ids silently.
  const { applied } = await apiOutcome(mcpApiContext(ctx), ids, good);
  return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
}

export async function runLearnTool({ args, ctx }: ToolCall): Promise<string> {
  // 0 reads as unset, as it always has.
  const days = numberArg(args, 'days') || DEFAULT_LEARN_DAYS;
  // process.cwd() is the server's repo, not a remote caller's, so api learn refuses all but stdio and a host admin
  // (mcpActor fails closed).
  const result = await apiLearn(mcpApiContext(ctx), {
    repoPath: process.cwd(),
    days,
    profile: MCP_LEARN,
    git: processGit,
  });
  if (result.status === 'not-a-repo') return 'No git history found.';
  if (result.status === 'no-commits') return 'No fix/revert/bug commits found in the specified period.';
  const { added, skipped, rejected, lowInfo } = result;
  const rejectedSuffix = rejected > 0 ? `, ${rejected} rejected values skipped` : '';
  const lowInfoSuffix = lowInfo > 0 ? `, ${lowInfo} low-information subjects dropped` : '';
  return `Git learn: ${added} new, ${skipped} duplicates skipped${rejectedSuffix}${lowInfoSuffix} (scanned ${days} days)`;
}
