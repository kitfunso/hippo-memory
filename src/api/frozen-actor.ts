import type { Actor } from './types.js';

/** A frozen copy with its own frozen scopes, so a JS hook that mutates its argument cannot change
 * the request's actor. */
export function frozenActor(actor: Actor): Readonly<Actor> {
  const scopes = actor.scopes;
  return Object.freeze({
    ...actor,
    ...(scopes !== undefined && { scopes: Object.freeze([...scopes]) }),
  });
}
