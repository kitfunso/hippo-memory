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
export const PACKAGE_VERSION = '1.3.1';
// (already 1.3.1 — kept this comment as a reminder: bump on every release.)

/**
 * Compare two semver strings. Returns positive if a > b, 0 if equal, negative
 * if a < b. Pre-release tags are not handled — releases use plain x.y.z.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((n) => Number(n) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return (a1 ?? 0) - (b1 ?? 0);
  if (a2 !== b2) return (a2 ?? 0) - (b2 ?? 0);
  return (a3 ?? 0) - (b3 ?? 0);
}
