// The boundary to benchmarks/memory-value/*.json, whose keys are snake_case: the domain holds
// camelCase, and this is the only place a key changes case on the way in.

const toCamel = (key: string): string =>
  key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

/** An artifact's number record with its keys in camelCase, in the artifact's key order. */
export function fromArtifact(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [toCamel(k), v]));
}
