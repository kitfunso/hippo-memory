import { envSlackAllowUnknownTeamFallback, envTenant } from '../../util/env.js';
import { requireGroup, storeFor, type HippoStore } from '../../store/index.js';
import type { SlackTeamRoute } from '../../store/connectors/slack.js';

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
export async function resolveTenantForSlackTeam(hippoRoot: string, teamId: string, store?: HippoStore): Promise<string | null> {
  return tenantForRoute(await requireGroup(storeFor({ hippoRoot, store }), 'connectorEvents').slackTeamRoute(teamId));
}

function tenantForRoute(route: SlackTeamRoute): string | null {
  if (route.tenantId !== null) return route.tenantId;
  if (route.workspaceCount === 0) {
    // Single-workspace install: env fallback is safe.
    return envTenant();
  }

  if (envSlackAllowUnknownTeamFallback()) {
    return envTenant();
  }

  return null; // fail closed
}
