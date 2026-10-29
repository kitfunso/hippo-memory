// A CLI command for a test that calls verb or api code directly, built as the CLI root builds one.
import { StoreRuntime } from '../../src/db/store-runtime.js';
import { cliCommand, type CliCommand } from '../../src/surface/cli/api-context.js';
import { withStoreRuntime } from '../../src/surface/open-store.js';

/** Runs `run` on a command whose store runtime is disposed when `run` settles, as the CLI root
 * disposes a verb's, so held writes land and pooled handles close before the test cleans up. */
export function asCommand<T>(run: (cli: CliCommand) => T | Promise<T>): Promise<T> {
  return withStoreRuntime(async (runtime) => run(cliCommand(runtime)));
}

const lasting: StoreRuntime[] = [];

/** A command that outlives one call, as a stdio loop's or a background sleep's does; the test file
 * ends it with endLastingCommands before it removes the folders it used. */
export function lastingCommand(): CliCommand {
  const runtime = new StoreRuntime();
  lasting.push(runtime);
  return cliCommand(runtime);
}

/** Disposes every command lastingCommand made since the last call. */
export function endLastingCommands(): void {
  for (const runtime of lasting.splice(0)) runtime.dispose();
}
