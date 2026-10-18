import type { HippoStore } from '../../store/index.js';
import type { SlackTeamRoute } from '../../store/port/connectors.js';

/** The host's tenant, which the root resolved, and the root's SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK. */
export interface SlackFallback {
  readonly hostTenant: string;
  readonly allowUnknown: boolean;
}

/** Look up the tenant_id for a Slack team_id; the host tenant applies only when slack_workspaces is empty
 * (single-workspace install). An unknown team on a multi-workspace install returns null (fail closed); `allowUnknown`
 * is the emergency escape. */
export async function resolveTenantForSlackTeam(
  store: HippoStore,
  teamId: string,
  fallback: SlackFallback,
): Promise<string | null> {
  return tenantForRoute(await store.connectorEvents.slackTeamRoute(teamId), fallback);
}

function tenantForRoute(route: SlackTeamRoute, { hostTenant, allowUnknown }: SlackFallback): string | null {
  if (route.tenantId !== null) return route.tenantId;
  // Single-workspace install: the host fallback is safe.
  if (route.workspaceCount === 0 || allowUnknown) return hostTenant;
  return null; // fail closed
}
