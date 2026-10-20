// A flush tags the error it stopped on with the unit it would have committed next, so the partial sleep audit row can
// name it; a WeakMap, since the error object itself is what reaches the sleep that reports it.
const failedUnits = new WeakMap<Error, string[]>();

/** Tags `err` with the ids of the unit it stopped at; the first tag wins. */
export function noteFailedUnit(err: Error, ids: readonly string[]): void {
  if (!failedUnits.has(err)) failedUnits.set(err, [...new Set(ids)]);
}

/** The ids noteFailedUnit tagged `err` with, if a flush threw it. */
export function failedUnitOf(err: Error | null): string[] | undefined {
  return err ? failedUnits.get(err) : undefined;
}
