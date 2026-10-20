// Store health and admin tool handlers: base rates, status, conflicts, resolve, share and peers.

import { evalNow } from '../../base/memory/ablation.js';
import { ConflictError, NotFoundError } from '../../base/errors/api-errors.js';
import { predictionBaserate } from '../../api/objects/predictions.js';
import { conflictListAll, conflictListOpen, conflictResolve } from '../../api/memories/conflicts.js';
import { memoryStatusGet, memoryGetTouchable } from '../../api/memories/memories.js';
import { mcpApiContext, type LocalToolCall, type ToolCall } from './protocol.js';
import { sharePeers, shareToGlobal } from '../../api/sharing.js';
import { MAX_ID_LEN, MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import { boolArg, numberArg, optionalStringArg, stringArg } from './tool-args.js';
import { DATE_PREFIX_CHARS } from '../../base/util/token-text.js';
import { AT_RISK_BELOW } from '../../base/memory/strength-bands.js';

const BASERATE_DECIMALS = 3;

const NOT_RESOLVED = 'Could not resolve. Check the conflict ID and --keep value.';

export async function runPredictBaserateTool({ args, ctx }: ToolCall): Promise<string> {
  // Text-only reply, matching the other MCP tools; the group's read writes the audit row, so no surface can skip it.
  const classTag = stringArg(args, 'class_tag', MAX_ID_LEN).trim();
  if (!classTag) {
    return 'No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort").';
  }
  const baserate = await predictionBaserate(mcpApiContext(ctx), classTag);
  if (baserate.nClosed === 0) {
    return (
      `No closed predictions in class "${classTag}" yet. Create one via hippo_predict (or 'hippo predict ...' CLI) ` +
      `and close it with hippo_predict_close once the actual outcome is known. ` +
      `Base rates need closed predictions with numeric actual_value to compute.`
    );
  }
  const lines: string[] = [baserate.summary, ''];
  lines.push(`n_closed:         ${baserate.nClosed}`);
  lines.push(`n_ratio_eligible: ${baserate.nRatioEligible}`);
  if (baserate.meanEstimate !== null) {
    lines.push(`mean_estimate:    ${baserate.meanEstimate.toFixed(BASERATE_DECIMALS)}`);
  }
  if (baserate.meanActual !== null) lines.push(`mean_actual:      ${baserate.meanActual.toFixed(BASERATE_DECIMALS)}`);
  if (baserate.meanRatio !== null) lines.push(`mean_ratio:       ${baserate.meanRatio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.p50Ratio !== null) lines.push(`p50_ratio:        ${baserate.p50Ratio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.mae !== null) lines.push(`mae:              ${baserate.mae.toFixed(BASERATE_DECIMALS)}`);
  return lines.join('\n');
}

export async function runStatusTool({ ctx, config }: ToolCall): Promise<string> {
  // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const tallies = await memoryStatusGet(mcpApiContext(ctx), evalNow(), AT_RISK_BELOW);
  const avgStrength = tallies.total > 0 ? (tallies.strengthSum / tallies.total).toFixed(2) : '0';
  return [
    `Memories: ${tallies.total} (${tallies.pinned} pinned, ${tallies.errors} errors)`,
    `Avg strength: ${avgStrength}`,
    `At risk (<${AT_RISK_BELOW}): ${tallies.atRisk}`,
    `Open conflicts: ${tallies.openConflicts}`,
    `Half-life default: ${config.defaultHalfLifeDays}d`,
  ].join('\n');
}

export async function runConflictsTool(call: ToolCall): Promise<string> {
  const { ctx } = call;
  const apiCtx = mcpApiContext(ctx);
  const conflicts = await conflictListAll((page) => conflictListOpen(apiCtx, { ...page, project: ctx?.project }));
  if (conflicts.length === 0) return 'No open conflicts.';
  return conflicts
    .map((c) => `conflict_${c.id}: ${c.memory_a_id} <-> ${c.memory_b_id} (score=${c.score.toFixed(2)}) — ${c.reason}`)
    .join('\n');
}

export async function runResolveTool({ args, ctx }: ToolCall): Promise<string> {
  const conflictId = numberArg(args, 'conflict_id');
  const keepId = stringArg(args, 'keep', MAX_ID_LEN);
  const forget = boolArg(args, 'forget');
  const rejectLoser = boolArg(args, 'rejectLoser');
  const reason = optionalStringArg(args, 'reason', MAX_SHORT_FIELD_LEN);
  if (conflictId === undefined || !keepId) return 'Required: conflict_id and keep.';
  let loserId: string;
  try {
    const apiCtx = mcpApiContext(ctx);
    ({ loserId } = await conflictResolve(apiCtx, conflictId, { keepId, forget, rejectLoser, reason }));
  } catch (err) {
    // A missing, unreachable or settled conflict answers alike, so the reply says nothing of a pair the caller cannot
    // touch.
    if (err instanceof NotFoundError || err instanceof ConflictError) return NOT_RESOLVED;
    throw err;
  }
  const action = rejectLoser ? 'rejected (tombstoned) and removed' : forget ? 'deleted' : 'weakened';
  return `Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${loserId}`;
}

export async function runShareTool({ args, ctx, store }: LocalToolCall): Promise<string> {
  const shareId = stringArg(args, 'id', MAX_ID_LEN);
  if (!shareId) return 'Required: id (memory ID to share).';
  const force = boolArg(args, 'force');
  const apiCtx = mcpApiContext(ctx);
  // Checked before the share, whose personal-row refusal would tell another person the id exists.
  await memoryGetTouchable(apiCtx, shareId);
  // The share reads the id in the caller's tenant only, so tenant A cannot copy tenant B's row to the global store.
  const shared = await shareToGlobal({ ...apiCtx, store }, shareId, { force });
  if (!shared) return 'Transfer score too low. Use force=true to override.';
  return `Shared [${shared.id}] to global store. Source: ${shared.source}`;
}

export async function runPeersTool({ ctx }: LocalToolCall): Promise<string> {
  // Tenant-scope peer discovery to the caller, as hippo_share does.
  const peers = await sharePeers(mcpApiContext(ctx));
  if (peers.length === 0) return 'No peers found.';
  return peers
    .map((p) => `${p.project}: ${p.count} memories (latest: ${p.latest.slice(0, DATE_PREFIX_CHARS)})`)
    .join('\n');
}
