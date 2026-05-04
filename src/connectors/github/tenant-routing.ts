import type { DatabaseSyncLike } from '../../db.js';

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
 *         account — codex P0 #4 regression target)
 *
 * Escape hatch: `GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK=1` restores the
 * env fallback for emergency rollback only. Mirrors the Slack equivalent
 * (`SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK`).
 *
 * The fail-closed contract lives here so every caller (route handler, CLI
 * replay, future MCP) gets identical protection.
 */
export function resolveTenantForGitHub(
  db: DatabaseSyncLike,
  args: ResolveArgs,
): string | null {
  const envFallback = (): string => process.env.HIPPO_TENANT?.trim() || 'default';
  const escapeHatch = process.env.GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK === '1';

  const instCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM github_installations`)
    .get() as { c: number | bigint }).c;
  const repoCount = (db
    .prepare(`SELECT COUNT(*) AS c FROM github_repositories`)
    .get() as { c: number | bigint }).c;

  if (args.installationId) {
    const row = db
      .prepare(`SELECT tenant_id FROM github_installations WHERE installation_id = ?`)
      .get(args.installationId) as { tenant_id?: string } | undefined;
    if (row?.tenant_id) return row.tenant_id;
    if (Number(instCount) === 0) {
      // Single-tenant install (table empty); env fallback is safe.
      return envFallback();
    }
    // Multi-tenant install with unknown installation_id — fail closed.
    return escapeHatch ? envFallback() : null;
  }

  // No installation.id (PAT-mode webhook).
  if (Number(instCount) === 0 && Number(repoCount) === 0) {
    // Single-tenant deployment with no routing tables populated.
    return envFallback();
  }
  if (args.repoFullName) {
    const row = db
      .prepare(
        `SELECT tenant_id FROM github_repositories WHERE repo_full_name = ? ORDER BY added_at, tenant_id LIMIT 1`,
      )
      .get(args.repoFullName) as { tenant_id?: string } | undefined;
    if (row?.tenant_id) return row.tenant_id;
  }
  return escapeHatch ? envFallback() : null;
}
