// The adapter's synchronous form of the port: private here, since the port itself answers only through Promises.
import { inPortTerms } from './port-errors.js';

/** `T` with each method answering its value instead of a Promise of it, groups included: hippo.db's bodies run to their
 * end on one handle, and `served` wraps them back into the port. */
export type Sync<T> = T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => R
  : T extends (...args: never) => void
    ? T
    : T extends object
      ? { [K in keyof T]: Sync<T[K]> }
      : T;

/** A sync store or group as a served one: each method runs at once and a throw rejects in the port's terms, as another
 * store's would, and a group inside it is served the same way, as `Sync` maps groups too. */
export function served<T extends object>(sync: NoInfer<Sync<T>>): T {
  const out: Partial<T> = {};
  // SAFETY: Object.keys lists the own keys of the sync group, which are keys of T by the Sync<T> mapping.
  for (const key of Object.keys(sync) as (keyof T & keyof Sync<T>)[]) {
    const value = sync[key];
    let wrapped;
    if (value instanceof Function) wrapped = async (...args: never[]) => inPortTerms(() => value.apply(sync, args));
    else wrapped = isGroup(value) ? served(value) : value;
    // SAFETY: Sync<T> maps each member of T to its synchronous twin, so serving that twin gives the T member.
    out[key] = wrapped as T[typeof key];
  }
  // SAFETY: every own key of the sync group was copied or wrapped above, so out holds all of T.
  return out as T;
}

/** A plain object literal, which is how every sync group is built; a Map or an array is a value, not a group. */
function isGroup<V>(value: V): value is V & object {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
