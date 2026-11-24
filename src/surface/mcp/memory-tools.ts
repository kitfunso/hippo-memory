import {
  remember as apiRemember,
  outcome as apiOutcome,
  learn as apiLearn,
  MCP_LEARN,
} from '../../api/index.js';
import { ERROR_TAG } from '../../base/memory/entry.js';
import { mcpApiContext, type GroupToolCall, type ToolCall } from './protocol.js';
import { keptShownIds } from '../../api/recall/last-recalled.js';
import { DEFAULT_LEARN_DAYS, MAX_CONTENT_LEN, MAX_ID_LEN } from '../../base/util/limits.js';
import { boolArg, numberArg, optionalStringArg, stringArg } from './tool-args.js';

export async function runRememberTool({ args, ctx }: ToolCall): Promise<string> {
  const text = stringArg(args, 'text', MAX_CONTENT_LEN);
  if (!text) return 'No text provided.';
  const tags: string[] = [];
  if (boolArg(args, 'error')) tags.push(ERROR_TAG);
  const tag = stringArg(args, 'tag', MAX_ID_LEN);
  if (tag) tags.push(tag);
  const result = await apiRemember(mcpApiContext(ctx), {
    content: text,
    leadIn: optionalStringArg(args, 'lead_in', MAX_CONTENT_LEN),
    tags,
    personal: boolArg(args, 'personal'),
    project: ctx?.project,
  });

  const tagStr = result.tags.join(', ') || 'none';
  const warnings = (result.warnings ?? []).map((w) => `\nWarning: ${w}`).join('');
  if (result.quarantined) {
    const reason = result.quarantined.reason;
    return `Quarantined [${result.id}] for admin review (reason: ${reason}, tags: ${tagStr})${warnings}`;
  }
  return `Remembered [${result.id}] (half-life: ${result.halfLifeDays}d, tags: ${tagStr})${warnings}`;
}

export async function runOutcomeTool({ args, ctx }: ToolCall): Promise<string> {
  const good = boolArg(args, 'good');
  const apiCtx = mcpApiContext(ctx);
  const ids = keptShownIds(apiCtx);
  if (ids.length === 0) return 'No recent recalls to apply outcome to.';

  const { applied } = await apiOutcome(apiCtx, ids, good);
  return `Applied ${good ? 'positive' : 'negative'} outcome to ${applied} memories`;
}

export async function runLearnTool({
  args,
  api,
}: GroupToolCall<'lessonWrites' | 'vectors' | 'vectorWrites'>): Promise<string> {
  const days = numberArg(args, 'days') || DEFAULT_LEARN_DAYS;
  const result = await apiLearn(api, { days, profile: MCP_LEARN });
  if (result.status === 'not-a-repo') return 'No git history found.';
  if (result.status === 'no-commits') {
    return 'No fix/revert/bug commits found in the specified period.';
  }
  const { added, skipped, rejected, lowInfo } = result;
  const rejectedSuffix = rejected > 0 ? `, ${rejected} rejected values skipped` : '';
  const lowInfoSuffix = lowInfo > 0 ? `, ${lowInfo} low-information subjects dropped` : '';
  return `Git learn: ${added} new, ${skipped} duplicates skipped${rejectedSuffix}${lowInfoSuffix} (scanned ${days} days)`;
}
