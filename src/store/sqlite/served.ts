import type { Sync } from '../port.js';

/** A sync group as a served one: each method runs at once and a throw rejects, as another store's would. */
export function served<T extends object>(sync: NoInfer<Sync<T>>): T {
  const out: Partial<T> = {};
  // SAFETY: Object.keys lists the own keys of the sync group, which are keys of T by the Sync<T> mapping.
  for (const key of Object.keys(sync) as (keyof T & keyof Sync<T>)[]) {
    const value = sync[key];
    const wrapped = value instanceof Function ? async (...args: never[]) => value.apply(sync, args) : value;
    // SAFETY: Sync<T> maps each method of T to its synchronous twin, so an async wrapper of it is the T method.
    out[key] = wrapped as T[typeof key];
  }
  // SAFETY: every own key of the sync group was copied or wrapped above, so out holds all of T.
  return out as T;
}
