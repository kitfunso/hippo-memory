// Store health and admin tool handlers: base rates, status, conflicts, resolve, share and peers.

import { calculateStrength } from '../memory.js';
import { evalNow } from '../ablation.js';
import { loadStrengthRows } from '../store/candidates.js';
import { listMemoryConflicts, resolveConflict } from '../store/conflicts.js';
import { shareMemory, listPeers } from '../shared.js';
import { computePredictionBaserate } from '../predictions/store.js';
import { closeHippoDb, openHippoDb } from '../db.js';
import { NotFoundError } from '../api-errors.js';
import { canTouchScope } from '../recall-scope.js';
import { selectMemoryReach } from '../store/tenant-lookup.js';
import { mcpActor, type ToolCall } from './protocol.js';
import { isJsonString } from '../json.js';

/** The scope of memory `id`, null when it has none or does not exist. */
function memoryScope(hippoRoot: string, id: string): string | null {
  const db = openHippoDb(hippoRoot);
  try {
    return selectMemoryReach(db, id)?.scope ?? null;
  } finally {
    closeHippoDb(db);
  }
}

export function runPredictBaserateTool({ args, ctx, hippoRoot, tenantId }: ToolCall): string {
  // Text-only reply, matching the other MCP tools; the helper opens its own db
  // and emits the audit, so call sites cannot drift.
  const classTag = String(args.class_tag || '').trim();
  if (!classTag) return 'No class_tag provided. Usage: pass class_tag matching a class used in past predictions (e.g. "migration-effort").';
  const baserate = computePredictionBaserate(hippoRoot, tenantId, classTag, ctx?.actor ?? 'mcp');
  if (baserate.nClosed === 0) {
    return `No closed predictions in class "${classTag}" yet. Create one via hippo_predict (or 'hippo predict ...' CLI) and close it with hippo_predict_close once the actual outcome is known. Base rates need closed predictions with numeric actual_value to compute.`;
  }
  const lines: string[] = [baserate.summary, ''];
  lines.push(`n_closed:         ${baserate.nClosed}`);
  lines.push(`n_ratio_eligible: ${baserate.nRatioEligible}`);
  if (baserate.meanEstimate !== null) lines.push(`mean_estimate:    ${baserate.meanEstimate.toFixed(3)}`);
  if (baserate.meanActual !== null)   lines.push(`mean_actual:      ${baserate.meanActual.toFixed(3)}`);
  if (baserate.meanRatio !== null)    lines.push(`mean_ratio:       ${baserate.meanRatio.toFixed(3)}x`);
  if (baserate.p50Ratio !== null)     lines.push(`p50_ratio:        ${baserate.p50Ratio.toFixed(3)}x`);
  if (baserate.mae !== null)          lines.push(`mae:              ${baserate.mae.toFixed(3)}`);
  return lines.join('\n');
}

export function runStatusTool({ hippoRoot, config, tenantId }: ToolCall): string {
  // Every row counts toward the averages, so this scans the store, but without its text.
  const entries = loadStrengthRows(hippoRoot, tenantId);
  const now = evalNow(); // honors HIPPO_FAKE_NOW (eval-only; see ablation.ts)
  let atRisk = 0;
  let totalStrength = 0;
  for (const e of entries) {
    const s = calculateStrength(e, now);
    totalStrength += s;
    if (s < 0.1 && !e.pinned) atRisk++;
  }
  const avgStrength = entries.length > 0 ? (totalStrength / entries.length).toFixed(2) : '0';
  const pinned = entries.filter((e) => e.pinned).length;
  const errors = entries.filter((e) => e.tags.includes('error')).length;
  const conflicts = listMemoryConflicts(hippoRoot, 'open', tenantId).length;
  return [
    `Memories: ${entries.length} (${pinned} pinned, ${errors} errors)`,
    `Avg strength: ${avgStrength}`,
    `At risk (<0.1): ${atRisk}`,
    `Open conflicts: ${conflicts}`,
    `Half-life default: ${config.defaultHalfLifeDays}d`,
  ].join('\n');
}

export function runConflictsTool({ hippoRoot, tenantId }: ToolCall): string {
  const conflicts = listMemoryConflicts(hippoRoot, 'open', tenantId);
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
  const result = resolveConflict(hippoRoot, conflictId, keepId, forget, tenantId, {
    rejectLoserValue: rejectLoser,
    reason,
    // rejectedBy defaults to 'cli', so name the real actor for the tombstone and audit:
    // ctx.actor for HTTP-MCP, 'mcp' for stdio callers, which pass no ctx.
    rejectedBy: ctx?.actor ?? 'mcp',
  });
  if (!result) return 'Could not resolve. Check the conflict ID and --keep value.';
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
  return peers.map((p) => `${p.project}: ${p.count} memories (latest: ${p.latest.slice(0, 10)})`).join('\n');
}
