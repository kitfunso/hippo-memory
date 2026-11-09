// Here, not in base/memory, since scope already imports memory and the quarantine test is scope's.
import { isSuperseded } from '../memory/liveness.js';
import { isQuarantineScope } from './recall-scope.js';

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
