// The CLI process's store runtime, apart from api-context.ts so cli.ts can end a command without loading the verbs'
// store wiring.
import { openRootStoreRuntime } from '../open-store.js';

/** Every store a CLI command builds holds it; its exit hook disposes it if the process exits mid-command. */
export const cliRuntime = openRootStoreRuntime();

/** Runs `fn` as one command: when it settles, the command's held writes run and its idle handles close. */
export async function runCliCommand<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    cliRuntime.dispose();
  }
}
