// The artifact's snake_case spelling of a domain number record, for round-trip checks.

/** `record` with each camelCase key back in snake_case, in the same order. */
export function toArtifact(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]),
  );
}
