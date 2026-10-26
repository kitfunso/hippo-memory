// The ports a published entry fills into a Context its caller built without them, from one source for every entry, so
// the process builds one reranker registry however many entries it calls.
import type { InfraPorts } from '../base/ports/infra.js';
import { FailureNotices } from '../base/util/failure-notices.js';
import type { EntryInfraPorts } from '../api/types.js';
import { createHost } from '../host/host.js';
import { rootInfra } from '../infra/ports.js';

/** The published entries' Host, which their reach probes and project walks share for the process's life. */
export const entryHost = createHost();

/** The failures the published entries have warned about, whoever built the rest of a caller's ports. */
const entryNotices = new FailureNotices();

/** The published entries' infra source, built on first use. */
export const entryInfra = rootInfra(entryHost, entryNotices);

/** `ctx` with the real ports when its builder set none, as EntryContext documents. */
export function withEntryInfra<C extends { readonly infra?: EntryInfraPorts }>(
  ctx: C,
): C & { readonly infra: InfraPorts } {
  const { infra } = ctx;
  if (infra === undefined) return { ...ctx, infra: entryInfra() };
  return { ...ctx, infra: { ...infra, failureNotices: infra.failureNotices ?? entryNotices } };
}
