// The CLI command's store runtime, apart from api-context.ts so cli.ts can end a command without
// loading the verbs' store wiring.
import { withStoreRuntime, type StoreRuntime } from '../open-store.js';

// One command per process, so its runtime is root state as its session is; between commands a store
// pools nothing.
let commandRuntime: StoreRuntime | undefined;

/** The running command's runtime, which every store it builds holds; undefined outside a
 * command. */
export function cliRuntime(): StoreRuntime | undefined {
  return commandRuntime;
}

/** Runs `fn` as one command: when it settles, its held writes run and its idle handles close. A
 * command run inside another, as a test's in-process runCli is, shares the outer one's runtime. */
export async function runCliCommand<T>(fn: () => Promise<T>): Promise<T> {
  if (commandRuntime !== undefined) return fn();
  return withStoreRuntime(async (runtime) => {
    commandRuntime = runtime;
    try {
      return await fn();
    } finally {
      commandRuntime = undefined;
    }
  });
}
