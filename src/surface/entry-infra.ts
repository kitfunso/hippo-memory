// The ports a published entry fills into a Context its caller built without them, from one source
// for every entry, so the process builds one reranker registry however many entries it calls.
import type { InfraPorts } from '../base/ports/infra.js';
import { FailureNotices } from '../base/util/failure-notices.js';
import type { Context, EntryContext, EntryInfraPorts } from '../api/types.js';
import { withCoreEnrichment, type EnrichedFields } from '../api/hippo-db-context.js';
import { createHost } from '../host/host.js';
import { rootInfra } from '../infra/ports.js';
import { evalSwitches } from '../infra/eval-switches.js';
import { PRODUCTION_SWITCHES } from '../base/memory/eval-switches.js';

/** The published entries' Host, which their reach probes and project walks share for the
 * process's life. */
export const entryHost = createHost();

/** The failures the published entries have warned about, whoever built the rest of a
 * caller's ports. */
const entryNotices = new FailureNotices();

const entryRoot = rootInfra(entryHost, entryNotices);

/** The published entries' ports, built on first use and scoring by the switches a frozen eval
 * set, read as each Context is built. */
export function entryInfra(): InfraPorts {
  return { ...entryRoot(), ...evalSwitches() };
}

/** `ctx` with the real ports when its builder set none, as EntryContext documents, and its
 * store's local tier as the core paths read it when the builder set no `enrich`. */
export function withEntryInfra<C extends EntryFields>(ctx: C): C & { readonly infra: InfraPorts } {
  const { infra } = ctx;
  const given = infra && {
    ...infra,
    failureNotices: infra.failureNotices ?? entryNotices,
    strength: infra.strength ?? PRODUCTION_SWITCHES.strength,
    rank: infra.rank ?? PRODUCTION_SWITCHES.rank,
  };
  return { ...withCoreEnrichment(ctx), infra: given ?? entryInfra() };
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
