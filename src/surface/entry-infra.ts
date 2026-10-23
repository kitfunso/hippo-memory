// The ports a published entry fills into a Context its caller built without them, from one source for every entry, so
// the process builds one reranker registry however many entries it calls.
import type { InfraPorts } from '../base/ports/infra.js';
import { createHost } from '../host/host.js';
import { rootInfra, withRealInfra } from '../infra/ports.js';

/** The published entries' Host, which their reach probes and project walks share for the process's life. */
export const entryHost = createHost();

/** The published entries' infra source, built on first use. */
export const entryInfra = rootInfra(entryHost);

/** `ctx` as it was when its builder set infra, else with the real ports, as Context.infra documents. */
export function withEntryInfra<C extends { readonly infra?: InfraPorts }>(ctx: C): C {
  return withRealInfra(ctx, entryInfra);
}
