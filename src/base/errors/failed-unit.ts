// A flush tags the error it stopped on with the unit it would have committed next, so the partial sleep audit row can
// name it; an own field, since a store worker's error reaches the sleep as a copy rebuilt from its fields.
interface FailedUnit {
  failedUnitIds?: unknown;
}

/** Tags `err` with the ids of the unit it stopped at; the first tag wins. */
export function noteFailedUnit(err: Error & FailedUnit, ids: readonly string[]): void {
  if (err.failedUnitIds === undefined) err.failedUnitIds = [...new Set(ids)];
}

/** The ids noteFailedUnit tagged `err` with, if a flush threw it. */
export function failedUnitOf(err: (Error & FailedUnit) | null): string[] | undefined {
  const ids = err?.failedUnitIds;
  return Array.isArray(ids) && ids.every((id): id is string => typeof id === 'string') ? ids : undefined;
}
