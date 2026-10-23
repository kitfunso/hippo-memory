// The ports a published entry fills into a Context its caller built without them, from one source for every entry, so
// the process builds one reranker registry however many entries it calls.
import type { InfraPorts } from '../base/ports/infra.js';
import { createHost } from '../host/host.js';
import { rootInfra } from '../infra/ports.js';

/** The published entries' Host, which their reach probes and project walks share for the process's life. */
export const entryHost = createHost();

/** The published entries' infra source, built on first use. */
export const entryInfra = rootInfra(entryHost);

/** `ctx` with the real ports when its builder set none, as EntryContext documents. */
export function withEntryInfra<C extends { readonly infra?: InfraPorts }>(ctx: C): C & { readonly infra: InfraPorts } {
  return { ...ctx, infra: ctx.infra ?? entryInfra() };
}
