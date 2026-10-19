// A CLI process holds its callers for its one command; a test that runs several commands in process holds one set
// across them, as one long-lived process would. Opt in with
// vi.mock('../../src/cli/api-context.js', async (orig) => (await import('../_helpers/held-cli-callers.js')).holdingCallers(await orig()));
import { createCallerState, type CallerState } from '../../src/api/callers.js';

type ApiContextModule = typeof import('../../src/cli/api-context.js');

let held: CallerState = createCallerState();

/** The callers every CLI command in this test file runs with until the next `freshCliCallers`. */
export const heldCliCallers = (): CallerState => held;

/** Empty callers for the next case, as a new process starts with. */
export function freshCliCallers(): CallerState {
  held = createCallerState();
  return held;
}

export function holdingCallers(real: ApiContextModule): ApiContextModule {
  return { ...real, cliApiContext: (root, tenant) => ({ ...real.cliApiContext(root, tenant), callers: held }) };
}
