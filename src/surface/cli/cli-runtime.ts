import { withStoreRuntime, type StoreRuntime } from '../open-store.js';
import { envReadOnly } from '../../base/util/env.js';

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
  return withStoreRuntime(
    async (runtime) => {
      commandRuntime = runtime;
      try {
        return await fn();
      } finally {
        commandRuntime = undefined;
      }
    },
    { readOnly: envReadOnly() },
  );
}
