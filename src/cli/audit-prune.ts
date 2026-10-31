// The `--older-than` flag of `hippo audit prune`; the prune itself is api.pruneAuditLog.

/** Parse `--older-than`: bare integer days (`30`) or with a `d` suffix (`30d`); throws on any other format. */
export function parseOlderThanFlag(raw: string): number {
  const m = raw.match(/^(\d+)(d)?$/i);
  if (!m) {
    throw new Error(
      `Invalid --older-than value: "${raw}". Expected integer days (e.g. "30") or with d suffix ("30d").`,
    );
  }
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --older-than value: "${raw}". Must be a positive integer.`);
  }
  return n;
}
