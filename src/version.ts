/**
 * Single source of truth for the hippo-memory binary's package version.
 *
 * Written by `npm version <x> --no-git-tag-version` through
 * scripts/sync-version.mjs, with the three plugin manifests; never edit it by
 * hand. scripts/check-manifest-versions.mjs gates publish on all seven sites.
 *
 * Used by:
 *   - src/db.ts rollback-safety guard (refuses to open a DB stamped with
 *     min_compatible_binary newer than this).
 *   - src/server.ts HTTP /health.
 *   - src/mcp/server.ts MCP serverInfo.
 *
 * Why not read package.json at runtime: the npm-published bundle ships
 * compiled `dist/` files that may not have package.json on a relative path
 * an ESM `import` can resolve cleanly, and a hardcoded constant survives
 * any packager that drops .json files.
 */
export const PACKAGE_VERSION = '1.46.0';

/** Compares plain x.y.z versions, positive if a > b; tags throw so the rollback guard never misfires silently. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const parts = v.split('.');
    if (parts.length !== 3 || parts.some((n) => !/^\d+$/.test(n))) {
      throw new Error(`compareSemver: expected numeric x.y.z without pre-release/build metadata: ${v}`);
    }
    return parts.map(Number);
  };
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return (a1 ?? 0) - (b1 ?? 0);
  if (a2 !== b2) return (a2 ?? 0) - (b2 ?? 0);
  return (a3 ?? 0) - (b3 ?? 0);
}
