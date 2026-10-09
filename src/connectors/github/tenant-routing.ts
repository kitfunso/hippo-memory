import { envGithubAllowUnknownInstallationFallback, envTenant } from '../../env.js';
import { requireGroup, storeFor, type HippoStore } from '../../store-port.js';

export interface ResolveArgs {
  /** String form of `installation.id`. `null`/`undefined` means "no installation field" (PAT-mode webhook). */
  installationId?: string | null;
  /** `repository.full_name` from the webhook envelope, used for PAT-mode multi-tenant routing. */
  repoFullName?: string | null;
}

/**
 * Resolve the tenant_id for a GitHub webhook envelope.
 *
 * Returns:
 *   - mapped tenant_id when `github_installations` has a row for `installationId`
 *     (App-mode multi-tenant — primary path)
 *   - mapped tenant_id when `installation` is absent, `repository.full_name`
 *     matches a `github_repositories` row (PAT-mode multi-tenant)
 *   - the deployment's HIPPO_TENANT fallback (or 'default') when BOTH routing
 *     tables are empty (single-tenant deployment — env fallback is safe)
 *   - null when:
 *       - `installationId` is present but unknown AND `github_installations`
 *         is non-empty (multi-tenant install with foreign installation)
 *       - `installationId` is missing AND either routing table is non-empty
 *         AND no `repository.full_name` match (PAT-mode webhook from a foreign
 *         account)
 *
 * Escape hatch: `GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK=1` restores the
 * env fallback for emergency rollback only. Mirrors the Slack equivalent
 * (`SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK`).
 *
 * The fail-closed contract lives here so every caller (route handler, CLI
 * replay, future MCP) gets identical protection.
 */
export async function resolveTenantForGitHub(
  hippoRoot: string,
  args: ResolveArgs,
  store?: HippoStore,
): Promise<string | null> {
  const envFallback = (): string => envTenant();
  const escapeHatch = envGithubAllowUnknownInstallationFallback();

  const routing = await requireGroup(storeFor({ hippoRoot, store }), 'connectorEvents').githubRouting(args);
  if (routing.tenant) return routing.tenant;

  if (args.installationId) {
    // An empty table is a single-tenant install, where the env fallback is safe; else fail closed.
    if (routing.installations === 0) return envFallback();
    return escapeHatch ? envFallback() : null;
  }

  // No installation.id (PAT-mode webhook) and no routing rows at all: single-tenant deployment.
  if (routing.installations === 0 && routing.repositories === 0) return envFallback();
  return escapeHatch ? envFallback() : null;
}
