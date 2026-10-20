// The adapter's synchronous form of the port: private here, since the port itself answers only through Promises.

/** `T` with each method answering its value instead of a Promise of it, groups included: hippo.db's bodies run to their
 * end on one handle, and `served` wraps them back into the port. */
export type Sync<T> = T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => R
  : T extends (...args: never) => void
    ? T
    : T extends object
      ? { [K in keyof T]: Sync<T[K]> }
      : T;

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
