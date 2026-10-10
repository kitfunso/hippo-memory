/** Single source of truth for the package version, written by scripts/sync-version.mjs; never edit by hand. Read by the db rollback guard, /health, MCP.
 * A constant, not a runtime package.json read: the published bundle may lack package.json on a path ESM can resolve. */
export const PACKAGE_VERSION = '1.71.0';

/** The floor a store takes on its first expiring key: the first release with schema
 * v53, set by hand in that release; scripts/check-expiring-keys-floor.mjs gates it. */
export const EXPIRING_KEYS_MIN_BINARY = '1.64.0';

/** The floor a store takes on its first session bind or owner snapshot: first release with v54; set by hand in that release. */
export const TASK_OWNER_MIN_BINARY = '1.64.0';

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
