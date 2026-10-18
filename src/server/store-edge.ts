// The server's one store capability check. The api checks no group, so a route row, or a request body that needs an
// optional group, proves it here and answers 501 when the store leaves it unset.
import type { Context, ContextWith } from '../api/types.js';
import { hasGroup, type HippoStore, type OptionalGroup, type StoreGroup, type StoreWith } from '../store/port.js';
import { HttpError, STORE_NOT_PORTED_MESSAGE } from '../util/http-util.js';

function storeSets<G extends OptionalGroup>(store: HippoStore, group: G): store is StoreWith<G>;
function storeSets(store: HippoStore, group: StoreGroup): boolean;
function storeSets(store: HippoStore, group: StoreGroup): boolean {
  return hasGroup(store, group);
}

/** Answers 501 unless `store` sets `group`, the one a route row names; no group means any store serves the row. */
export function assertStoreSets(store: HippoStore, group: StoreGroup | undefined): void {
  if (group !== undefined && !storeSets(store, group)) throw new HttpError(501, STORE_NOT_PORTED_MESSAGE);
}

/** `ctx` typed with the optional `group` its route row or request body needs; a store without it answers 501 with
 * `message`. */
export function needGroup<G extends OptionalGroup>(
  ctx: Context,
  group: G,
  message: string = STORE_NOT_PORTED_MESSAGE,
): ContextWith<G> {
  const { store } = ctx;
  if (!storeSets(store, group)) throw new HttpError(501, message);
  return { ...ctx, store };
}
