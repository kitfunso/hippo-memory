/** Writes a message the user asked for, or must act on, to stderr. */
export function printError(...args: unknown[]): void {
  console.error(...args);
}
