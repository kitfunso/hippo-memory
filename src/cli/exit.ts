// The one error a CLI verb throws to stop its command; runCli is the one place that turns it into the process exit code.

/** Thrown after the verb has printed its own message, so it carries the exit code and nothing for the entry to print. */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`hippo exits with code ${code}`);
    this.name = 'CliExit';
    this.code = code;
  }
}
