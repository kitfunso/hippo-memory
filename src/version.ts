/**
 * Single source of truth for the hippo-memory binary's package version.
 *
 * Bumped manually on every release alongside the four package manifests
 * (package.json, openclaw.plugin.json, extensions/openclaw-plugin/package.json,
 * extensions/openclaw-plugin/openclaw.plugin.json) and the lockfile.
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
export const PACKAGE_VERSION = '1.6.1';
// Bump on every release alongside the 4 manifests + lockfile.

/**
 * Compare two semver strings. Returns positive if a > b, 0 if equal, negative
 * if a < b.
 *
 * v1.3.2 (claude review): pre-release/build-metadata tags throw rather than
 * silently coerce. The v1.3.1 implementation used `Number(n) || 0` which
 * parsed `'1-beta'` as 0, so `'1.3.1-beta'` → `[1,3,0]` and compared LESS
 * than `'1.3.1'`. If anyone ever stamped a pre-release version into
 * `meta.min_compatible_binary`, the rollback guard would silently misfire.
 * Loud failure is the right call on a security-relevant compare.
 *
 * Releases use plain `x.y.z` (no pre-release tags). If you need
 * pre-release semantics later, replace this with a real semver lib.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((n) => {
      if (!/^\d+$/.test(n)) {
        throw new Error(`compareSemver: pre-release/build metadata not supported: ${v}`);
      }
      return Number(n);
    });
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return (a1 ?? 0) - (b1 ?? 0);
  if (a2 !== b2) return (a2 ?? 0) - (b2 ?? 0);
  return (a3 ?? 0) - (b3 ?? 0);
}
