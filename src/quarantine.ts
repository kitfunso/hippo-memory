/** Quarantine tier (CD5, AT3): pending/approved/rejected record for a memory `remember` flagged as untrusted. */

import { QUARANTINE_SCOPE_PREFIX } from './store/quarantine.js';

// The scope a held memory is stored under is the table's own rule, so the store module owns it.
export { quarantineScopeFor } from './store/quarantine.js';

export function isQuarantineScope(scope: string | null | undefined): boolean {
  return scope != null && scope.startsWith(QUARANTINE_SCOPE_PREFIX);
}
