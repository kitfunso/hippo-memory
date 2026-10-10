// Store health and admin tool handlers: base rates, status, conflicts, resolve, share and peers.

import { evalNow } from '../core/ablation.js';
import { shareMemory, listPeers } from '../sharing/share.js';
import { ConflictError, NotFoundError } from '../core/api-errors.js';
import { predictionBaserate } from '../api/predictions.js';
import { listOpenConflicts, resolveMemoryConflict } from '../api/conflicts.js';
import { getMemoryStatus, getTouchableMemory } from '../api/memories.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { isJsonString } from '../util/json.js';
import { DATE_PREFIX_CHARS } from '../util/token-text.js';

const BASERATE_DECIMALS = 3;

const NOT_RESOLVED = 'Could not resolve. Check the conflict ID and --keep value.';

export async function runPredictBaserateTool({ args, ctx, hippoRoot, tenantId }: ToolCall): Promise<string> {
  // Text-only reply, matching the other MCP tools; the group's read writes the audit row, so no surface can skip it.
  const classTag = String(args.class_tag || '').trim();
  if (!classTag) return 'No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort").';
  const baserate = await predictionBaserate({ hippoRoot, tenantId, actor: mcpActor(ctx), store: ctx?.store }, classTag);
  if (baserate.nClosed === 0) {
    return `No closed predictions in class "${classTag}" yet. Create one via hippo_predict (or 'hippo predict ...' CLI) and close it with hippo_predict_close once the actual outcome is known. Base rates need closed predictions with numeric actual_value to compute.`;
  }
  const lines: string[] = [baserate.summary, ''];
  lines.push(`n_closed:         ${baserate.nClosed}`);
  lines.push(`n_ratio_eligible: ${baserate.nRatioEligible}`);
  if (baserate.meanEstimate !== null) lines.push(`mean_estimate:    ${baserate.meanEstimate.toFixed(BASERATE_DECIMALS)}`);
  if (baserate.meanActual !== null)   lines.push(`mean_actual:      ${baserate.meanActual.toFixed(BASERATE_DECIMALS)}`);
  if (baserate.meanRatio !== null)    lines.push(`mean_ratio:       ${baserate.meanRatio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.p50Ratio !== null)     lines.push(`p50_ratio:        ${baserate.p50Ratio.toFixed(BASERATE_DECIMALS)}x`);
  if (baserate.mae !== null)          lines.push(`mae:              ${baserate.mae.toFixed(BASERATE_DECIMALS)}`);
  return lines.join('\n');
}

export function runStatusTool({ ctx, hippoRoot, config, tenantId }: ToolCall): string {
  // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const tallies = getMemoryStatus({ hippoRoot, tenantId, actor: mcpActor(ctx), store: ctx?.store }, evalNow(), 0.1);
  const avgStrength = tallies.total > 0 ? (tallies.strengthSum / tallies.total).toFixed(2) : '0';
    return [
    `Memories: ${tallies.total} (${tallies.pinned} pinned, ${tallies.errors} errors)`,
    `Avg strength: ${avgStrength}`,
    `At risk (<0.1): ${tallies.atRisk}`,
    `Open conflicts: ${tallies.openConflicts}`,
    `Half-life default: ${config.defaultHalfLifeDays}d`,
  ].join('\n');
}

export function runConflictsTool(call: ToolCall): string {
  const { ctx, hippoRoot, tenantId } = call;
  const conflicts = listOpenConflicts({ hippoRoot, tenantId, actor: mcpActor(ctx), store: ctx?.store }, ctx?.project);
  if (conflicts.length === 0) return 'No open conflicts.';
  return conflicts.map((c) =>
    `conflict_${c.id}: ${c.memory_a_id} <-> ${c.memory_b_id} (score=${c.score.toFixed(2)}) — ${c.reason}`
  ).join('\n');
}

export function runResolveTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const conflictId = Number(args.conflict_id);
  const keepId = String(args.keep || '');
  const forget = Boolean(args.forget);
  const rejectLoser = Boolean(args.rejectLoser);
  const reason = isJsonString(args.reason) ? args.reason : undefined;
  if (isNaN(conflictId) || !keepId) return 'Required: conflict_id and keep.';
  let loserId: string;
  try {
    const apiCtx = { hippoRoot, tenantId, actor: mcpActor(ctx), store: ctx?.store };
    ({ loserId } = resolveMemoryConflict(apiCtx, conflictId, { keepId, forget, rejectLoser, reason }));
  } catch (err) {
    // A missing, unreachable or settled conflict answers alike, so the reply says nothing of a pair the caller cannot touch.
    if (err instanceof NotFoundError || err instanceof ConflictError) return NOT_RESOLVED;
    throw err;
  }
  const action = rejectLoser ? 'rejected (tombstoned) and removed' : forget ? 'deleted' : 'weakened';
  return `Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${loserId}`;
}

export async function runShareTool({ args, ctx, hippoRoot, tenantId }: ToolCall): Promise<string> {
  const shareId = String(args.id || '');
  if (!shareId) return 'Required: id (memory ID to share).';
  const force = Boolean(args.force);
  const actor = mcpActor(ctx);
  // Checked before shareMemory, whose personal-row refusal would tell another person the id exists.
  await getTouchableMemory({ hippoRoot, tenantId, actor, store: ctx?.store }, shareId);
  // Pass tenantId so shareMemory's readEntry filters by tenant; otherwise a Bearer for tenant A could share tenant B's id to the global store.
  // The 'Memory not found' error matches the cross-tenant deny shape elsewhere.
  const shared = shareMemory(hippoRoot, shareId, { force, tenantId });
  if (!shared) return 'Transfer score too low. Use force=true to override.';
  return `Shared [${shared.id}] to global store. Source: ${shared.source}`;
}

export function runPeersTool({ tenantId }: ToolCall): string {
  // Tenant-scope peer discovery to the caller, as hippo_share does; undefined would list host-wide.
  const peers = listPeers(undefined, tenantId);
  if (peers.length === 0) return 'No peers found.';
  return peers.map((p) => `${p.project}: ${p.count} memories (latest: ${p.latest.slice(0, DATE_PREFIX_CHARS)})`).join('\n');
}
