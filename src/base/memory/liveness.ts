// A blank link counts as superseded: the CAS guard, recall and three partial indexes read it so.
import { isQuarantineScope } from '../scope/recall-scope.js';

/** True when the memory has a successor link of any value, a blank one included. */
export function isSuperseded<T extends { readonly supersededBy?: string | null }>(
  entry: T,
): entry is T & { readonly supersededBy: string } {
  return entry.supersededBy !== null && entry.supersededBy !== undefined;
}

/** True for a live memory: not superseded, kind raw or distilled, and not in a quarantine scope. */
export function isLiveMemory(entry: {
  readonly supersededBy?: string | null;
  readonly kind: string;
  readonly scope: string | null;
}): boolean {
  return (
    !isSuperseded(entry) &&
    (entry.kind === 'raw' || entry.kind === 'distilled') &&
    !isQuarantineScope(entry.scope)
  );
}
