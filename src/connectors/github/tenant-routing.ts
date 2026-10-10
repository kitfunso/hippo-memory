import { envGitHubAllowUnknownInstallationFallback, envTenant } from '../../util/env.js';
import { requireGroup, storeFor, type HippoStore } from '../../store/index.js';

export interface ResolveArgs {
  /** String form of `installation.id`. `null`/`undefined` means "no installation field" (PAT-mode webhook). */
  installationId?: string | null;
  /** `repository.full_name` from the webhook envelope, used for PAT-mode multi-tenant routing. */
  repoFullName?: string | null;
}

/** Resolve a GitHub envelope's tenant_id by installation id, then repository.full_name; the HIPPO_TENANT fallback applies only if both tables are empty.
 *  An unknown installation or repo on a multi-tenant deployment returns null (fail closed); GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK=1 escapes. */
export async function resolveTenantForGitHub(
  hippoRoot: string,
  args: ResolveArgs,
  store?: HippoStore,
): Promise<string | null> {
  const envFallback = (): string => envTenant();
  const escapeHatch = envGitHubAllowUnknownInstallationFallback();

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
