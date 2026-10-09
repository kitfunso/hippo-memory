/** Quarantine tier (CD5, AT3): pending/approved/rejected record for a memory `remember` flagged as untrusted. */

import { QUARANTINE_SCOPE_PREFIX } from './store/quarantine.js';

// The held scope and the record's insert are the table's own rules, so the store module owns them.
export { quarantineScopeFor, recordQuarantine } from './store/quarantine.js';

export function isQuarantineScope(scope: string | null | undefined): boolean {
  return scope != null && scope.startsWith(QUARANTINE_SCOPE_PREFIX);
}
