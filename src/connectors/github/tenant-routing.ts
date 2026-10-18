import type { HippoStore } from '../../store/index.js';

export interface ResolveArgs {
  /** String form of `installation.id`. `null`/`undefined` means "no installation field" (PAT-mode webhook). */
  installationId?: string | null;
  /** `repository.full_name` from the webhook envelope, used for PAT-mode multi-tenant routing. */
  repoFullName?: string | null;
}

/** The host's tenant, which the root resolved, and the root's GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK. */
export interface GitHubFallback {
  readonly hostTenant: string;
  readonly allowUnknown: boolean;
}

/** Resolve a GitHub envelope's tenant_id by installation id, then repository.full_name; the host tenant applies only if
 * both tables are empty. An unknown installation or repo on a multi-tenant deployment returns null (fail closed) unless
 * `allowUnknown` escapes. */
export async function resolveTenantForGitHub(
  store: HippoStore,
  args: ResolveArgs,
  { hostTenant, allowUnknown }: GitHubFallback,
): Promise<string | null> {
  const routing = await store.connectorEvents.githubRouting(args);
  if (routing.tenant) return routing.tenant;

  if (args.installationId) {
    // An empty table is a single-tenant install, where the host fallback is safe; else fail closed.
    if (routing.installations === 0) return hostTenant;
    return allowUnknown ? hostTenant : null;
  }

  // No installation.id (PAT-mode webhook) and no routing rows at all: single-tenant deployment.
  if (routing.installations === 0 && routing.repositories === 0) return hostTenant;
  return allowUnknown ? hostTenant : null;
}
