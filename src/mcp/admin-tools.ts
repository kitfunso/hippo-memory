// Store health and admin tool handlers: base rates, status, conflicts, resolve, share and peers.

import { evalNow } from '../core/ablation.js';
import { loadStrengthTallies } from '../store/candidates.js';
import { countOpenConflicts, listTouchableConflicts, resolveConflict } from '../store/conflicts.js';
import { shareMemory, listPeers } from '../sharing/share.js';
import { requireGroup, storeFor } from '../store/index.js';
import { NotFoundError } from '../core/api-errors.js';
import { classifyOriginProject } from '../core/project-identity.js';
import type { CallerProject } from '../api/prompt-hook.js';
import { canTouchScope, passesScopeFilterForRecall, personalScopeOf } from '../store/recall-scope.js';
import { chunked, loadEntriesByIds, readEntry } from '../store/entry-reads.js';
import type { MemoryConflict } from '../store/rows.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { isJsonString } from '../util/json.js';
import { DATE_PREFIX_CHARS } from '../util/token-text.js';

const BASERATE_DECIMALS = 3;

const NOT_RESOLVED = 'Could not resolve. Check the conflict ID and --keep value.';

/** The scope of memory `id`, null when it has none or does not exist. */
function memoryScope(hippoRoot: string, id: string): string | null {
  return readEntry(hippoRoot, id)?.scope ?? null;
}

export async function runPredictBaserateTool({ args, ctx, hippoRoot, tenantId }: ToolCall): Promise<string> {
  // Text-only reply, matching the other MCP tools; the group's read writes the audit row, so no surface can skip it.
  const classTag = String(args.class_tag || '').trim();
  if (!classTag) return 'No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort").';
  const baserate = await requireGroup(storeFor({ hippoRoot, store: ctx?.store }), 'predictions').predictionBaserate(tenantId, classTag, ctx?.actor ?? 'mcp');
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

export function runStatusTool({ hippoRoot, config, tenantId }: ToolCall): string {
  // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  const tallies = loadStrengthTallies(hippoRoot, tenantId, evalNow(), 0.1);
  const avgStrength = tallies.total > 0 ? (tallies.strengthSum / tallies.total).toFixed(2) : '0';
  const conflicts = countOpenConflicts(hippoRoot, tenantId);
  return [
    `Memories: ${tallies.total} (${tallies.pinned} pinned, ${tallies.errors} errors)`,
    `Avg strength: ${avgStrength}`,
    `At risk (<0.1): ${tallies.atRisk}`,
    `Open conflicts: ${conflicts}`,
    `Half-life default: ${config.defaultHalfLifeDays}d`,
  ].join('\n');
}

/** Pairs whose two rows the caller could recall: its repo or user-global, and no scope it was not asked for. */
function recallablePairs(call: ToolCall, conflicts: MemoryConflict[], project: CallerProject): MemoryConflict[] {
  const own = personalScopeOf(mcpActor(call.ctx));
  const ids = [...new Set(conflicts.flatMap((c) => [c.memory_a_id, c.memory_b_id]))];
  // loadEntriesByIds reads at most one chunk of ids per call.
  const rows = new Map(chunked(ids).flatMap((chunk) => loadEntriesByIds(call.hippoRoot, chunk, call.tenantId)).map((row) => [row.id, row]));
  const shown = (id: string): boolean => {
    const row = rows.get(id);
    return row !== undefined && classifyOriginProject(row.origin_project, project) !== 'cross-project'
      && passesScopeFilterForRecall(row.scope ?? null, undefined, own);
  };
  return conflicts.filter((c) => shown(c.memory_a_id) && shown(c.memory_b_id));
}

export function runConflictsTool(call: ToolCall): string {
  const { ctx, hippoRoot, tenantId } = call;
  const touchable = listTouchableConflicts(hippoRoot, 'open', tenantId, mcpActor(ctx));
  const conflicts = ctx?.project ? recallablePairs(call, touchable, ctx.project) : touchable;
  if (conflicts.length === 0) return 'No open conflicts.';
  return conflicts.map((c) =>
    `conflict_${c.id}: ${c.memory_a_id} <-> ${c.memory_b_id} (score=${c.score.toFixed(2)}) — ${c.reason}`
  ).join('\n');
}

export function runResolveTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const conflictId = Number(args.conflict_id);
  const keepId = String(args.keep || '');
  const forget = Boolean(args.forget);
  // Optional rejectLoser + reason pass straight to resolveConflict, as the CLI's --reject-loser does.
  const rejectLoser = Boolean(args.rejectLoser);
  const reason = isJsonString(args.reason) ? args.reason : undefined;
  if (isNaN(conflictId) || !keepId) return 'Required: conflict_id and keep.';
  if (!listTouchableConflicts(hippoRoot, 'open', tenantId, mcpActor(ctx)).some((c) => c.id === conflictId)) return NOT_RESOLVED;
  const result = resolveConflict(hippoRoot, conflictId, keepId, forget, tenantId, {
    rejectLoserValue: rejectLoser,
    reason,
    // rejectedBy defaults to 'cli', so name the real actor for the tombstone and audit:
    // ctx.actor for HTTP-MCP, 'mcp' for stdio callers, which pass no ctx.
    rejectedBy: ctx?.actor ?? 'mcp',
  });
  if (!result) return NOT_RESOLVED;
  const action = rejectLoser ? 'rejected (tombstoned) and removed' : forget ? 'deleted' : 'weakened';
  return `Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`;
}

export function runShareTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  const shareId = String(args.id || '');
  if (!shareId) return 'Required: id (memory ID to share).';
  const force = Boolean(args.force);
  // Checked before shareMemory, whose personal-row refusal would tell another person the id exists.
  if (!canTouchScope(mcpActor(ctx), memoryScope(hippoRoot, shareId))) throw new NotFoundError(`Memory not found: ${shareId}`);
  // Pass tenantId so shareMemory's readEntry filters by tenant. Without
  // this, a Bearer for tenant A could call hippo_share with tenant B's
  // id and copy the row to the global store. The 'Memory not found'
  // error matches the cross-tenant deny shape elsewhere in the code.
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
