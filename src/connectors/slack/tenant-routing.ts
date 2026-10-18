import { envTenant } from '../../util/env.js';
import type { HippoStore } from '../../store/index.js';
import type { SlackTeamRoute } from '../../store/port/connectors.js';

/** Look up the tenant_id for a Slack team_id; the HIPPO_TENANT fallback applies only when slack_workspaces is empty
 * (single-workspace install).
 * An unknown team on a multi-workspace install returns null (fail closed); `allowUnknownFallback`, the caller's
 * SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK, is the emergency escape. */
export async function resolveTenantForSlackTeam(
  store: HippoStore,
  teamId: string,
  allowUnknownFallback = false,
): Promise<string | null> {
  return tenantForRoute(await store.connectorEvents.slackTeamRoute(teamId), allowUnknownFallback);
}

function tenantForRoute(route: SlackTeamRoute, allowUnknownFallback: boolean): string | null {
  if (route.tenantId !== null) return route.tenantId;
  if (route.workspaceCount === 0) {
    // Single-workspace install: env fallback is safe.
    return envTenant();
  }

  if (allowUnknownFallback) {
    return envTenant();
  }

  return null; // fail closed
}
