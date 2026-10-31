// The ports a published entry fills into a Context its caller built without them, from one source
// for every entry, so the process builds one reranker registry however many entries it calls.
import type { InfraPorts } from '../base/ports/infra.js';
import { FailureNotices } from '../base/util/failure-notices.js';
import type { Context, EntryContext, EntryInfraPorts } from '../api/types.js';
import { withCoreEnrichment, type EnrichedFields } from '../api/hippo-db-context.js';
import { createHost } from '../host/host.js';
import { rootInfra } from '../infra/ports.js';

/** The published entries' Host, which their reach probes and project walks share for the
 * process's life. */
export const entryHost = createHost();

/** The failures the published entries have warned about, whoever built the rest of a caller's
 * ports. */
const entryNotices = new FailureNotices();

/** The published entries' infra source, built on first use. */
export const entryInfra = rootInfra(entryHost, entryNotices);

/** `ctx` with the real ports when its builder set none, as EntryContext documents, and its
 * store's local tier as the core paths read it when the builder set no `enrich`. */
export function withEntryInfra<C extends EntryFields>(ctx: C): C & { readonly infra: InfraPorts } {
  const { infra } = ctx;
  const notices = infra && { ...infra, failureNotices: infra.failureNotices ?? entryNotices };
  return { ...withCoreEnrichment(ctx), infra: notices ?? entryInfra() };
}

interface EntryFields extends EnrichedFields {
  readonly infra?: EntryInfraPorts;
}

/** `fn` with the entry's real ports filled into a Context its caller built without them. It keeps
 * `fn`'s name and length, since a published entry built here reads as the function it wraps. */
export function filled<A extends unknown[], R>(
  fn: (ctx: Context, ...args: A) => R,
): (ctx: EntryContext, ...args: A) => R {
  const entry = (ctx: EntryContext, ...args: A): R => fn(withEntryInfra(ctx), ...args);
  return Object.defineProperties(entry, {
    name: { value: fn.name },
    length: { value: fn.length },
  });
}
