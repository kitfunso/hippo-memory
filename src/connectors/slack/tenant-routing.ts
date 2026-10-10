import { envSlackAllowUnknownTeamFallback, envTenant } from '../../util/env.js';
import { requireGroup, storeFor, type HippoStore } from '../../store/index.js';
import type { SlackTeamRoute } from '../../store/connectors/slack.js';

/** Look up the tenant_id for a Slack team_id; the HIPPO_TENANT fallback applies only when slack_workspaces is empty (single-workspace install).
 *  An unknown team on a multi-workspace install returns null (fail closed); SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK=1 is the emergency escape. */
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
