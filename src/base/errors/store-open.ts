/** Thrown when a database's schema needs a newer binary; doctor picks the upgrade fix over a
 * permissions fix for it. */
export class IncompatibleBinaryError extends Error {}

/** Whether a store refused to open because its schema is newer than this binary reads. */
export function needsNewerHippo<E>(err: E): boolean {
  return err instanceof IncompatibleBinaryError;
}
