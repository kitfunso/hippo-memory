// The one error a CLI verb throws to stop its command; runCli is the one place that turns it into the process exit
// code.

import { printError } from './output.js';

/** Thrown after the verb has printed its own message, so it carries the exit code and nothing for the entry to
 * print. */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`hippo exits with code ${code}`);
    this.name = 'CliExit';
    this.code = code;
  }
}

/** Stops the verb with a message the user must act on: one call, so the text and the exit code 1 cannot drift apart. */
export function fail(...args: unknown[]): never {
  printError(...args);
  throw new CliExit(1);
}
