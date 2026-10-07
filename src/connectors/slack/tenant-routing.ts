import { envSlackAllowUnknownTeamFallback, envTenant } from '../../env.js';
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
 * The fail-closed contract lives here so every caller (route handler, CLI
 * replay, future MCP) gets the same protection against routing a foreign
 * workspace's events into the deployment tenant.
 */
export function resolveTenantForTeam(db: DatabaseSyncLike, teamId: string): string | null {
  // SAFETY: query selects only `tenant_id`, so a returned row has that shape;
  // .get() returns undefined when no row matches.
  const row = db
    .prepare(`SELECT tenant_id FROM slack_workspaces WHERE team_id = ?`)
    .get(teamId) as { tenant_id?: string } | undefined;
  if (row?.tenant_id) return row.tenant_id;

  // SAFETY: `COUNT(*) AS c` always returns exactly one row shaped { c }; sqlite
  // may return the count as number or bigint depending on driver.
  const total = (db
    .prepare(`SELECT COUNT(*) AS c FROM slack_workspaces`)
    .get() as { c: number | bigint }).c;
  if (Number(total) === 0) {
    // Single-workspace install: env fallback is safe.
    return envTenant();
  }

  if (envSlackAllowUnknownTeamFallback()) {
    return envTenant();
  }

  return null; // fail closed
}
