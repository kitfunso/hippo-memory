/** Quarantine tier (CD5, AT3): pending/approved/rejected record for a memory `remember` flagged as untrusted. */

// The scope a held memory is stored under is the table's own rule, so the store module owns it.
export { isQuarantineScope, quarantineScopeFor } from '../store/quarantine.js';
