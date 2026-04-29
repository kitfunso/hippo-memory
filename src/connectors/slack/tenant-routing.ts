import type { DatabaseSyncLike } from '../../db.js';

/**
 * Look up the tenant_id for a Slack team_id. Returns null when no row exists,
 * which signals "use the deployment's HIPPO_TENANT fallback". Multi-workspace
 * deployments populate slack_workspaces; single-workspace deployments leave
 * the table empty and rely on the env fallback.
 *
 * Review patch #6: dedicated routing seam — never inline this lookup at the
 * route handler so a future schema change (e.g. installation tokens) lands
 * in one place.
 */
export function resolveTenantForTeam(db: DatabaseSyncLike, teamId: string): string | null {
  const row = db
    .prepare(`SELECT tenant_id FROM slack_workspaces WHERE team_id = ?`)
    .get(teamId) as { tenant_id?: string } | undefined;
  return row?.tenant_id ?? null;
}
