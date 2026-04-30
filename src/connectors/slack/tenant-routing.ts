import type { DatabaseSyncLike } from '../../db.js';

/**
 * Look up the tenant_id for a Slack team_id.
 *
 * Returns:
 *   - mapped tenant_id when slack_workspaces has a row for `teamId`
 *   - the deployment's HIPPO_TENANT fallback (or 'default') when slack_workspaces
 *     is empty (single-workspace install — env fallback is safe)
 *   - null when slack_workspaces is non-empty AND `teamId` is unknown
 *     (multi-workspace install — fail closed; an unknown team is not the
 *     deployment's tenant). Escape hatch: SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK=1
 *     restores the env fallback for emergency rollback only.
 *
 * v0.39 commit 3 (CRITICAL #5): the previous version returned null on miss
 * unconditionally, and the route handler then fell back to HIPPO_TENANT —
 * which silently routed events from a foreign workspace into the deployment
 * tenant. The fail-closed contract lives here so every caller (route handler,
 * CLI replay, future MCP) gets the same protection.
 */
export function resolveTenantForTeam(db: DatabaseSyncLike, teamId: string): string | null {
  const row = db
    .prepare(`SELECT tenant_id FROM slack_workspaces WHERE team_id = ?`)
    .get(teamId) as { tenant_id?: string } | undefined;
  if (row?.tenant_id) return row.tenant_id;

  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM slack_workspaces`)
    .get() as { c: number | bigint }).c;
  if (Number(total) === 0) {
    // Single-workspace install: env fallback is safe.
    return process.env.HIPPO_TENANT?.trim() || 'default';
  }

  if (process.env.SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK === '1') {
    return process.env.HIPPO_TENANT?.trim() || 'default';
  }

  return null; // fail closed
}
