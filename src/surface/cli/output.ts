// User-facing CLI messages (usage, not-found, refusals) print at every HIPPO_LOG level; diagnostics go to `log`.
// Both forward to console.error so the bytes match the old calls and console spies in tests still see them.

/** Writes a message the user asked for, or must act on, to stderr. */
export function printError(...args: unknown[]): void {
  console.error(...args);
}
