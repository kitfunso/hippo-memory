// The one place an api function picks between a served store and hippo.db, so each operation has one body.
import { StoreNotPortedError } from '../util/sqlite-blocked.js';
import type { HippoStore, StoreGroups } from '../store/port.js';
import { NO_LOCAL, sqliteLocal, type SqliteLocal } from '../store/sqlite/local.js';
import { sqliteSyncStore, type SqliteSyncStore } from '../store/sqlite/store.js';
import type { Context, StoreReply } from './types.js';

/** What a port call answers: a Promise from a served store, the value itself from hippo.db. */
export type Reply<T> = T | Promise<T>;

/** The port one body is written against: a served store, or hippo.db answering the same methods at once. */
export type StorePort = HippoStore | SqliteSyncStore;

/** `next` on the reply's value, at once for a value, so hippo.db's path never becomes a Promise. */
export function andThen<T, U>(reply: Reply<T>, next: (value: T) => Reply<U>): Reply<U> {
  return reply instanceof Promise ? reply.then(next) : next(reply);
}

/** Stands in for a group the store lacks, as `port.keyAudit ?? notPorted(port, 'keyAudit')`; it answers 501 as any unported path does. */
export function notPorted(port: StorePort, group: keyof StoreGroups): never {
  throw new StoreNotPortedError(port.kind, group);
}

/** Runs `run` on `ctx.store`, where a throw rejects, else on hippo.db under `ctx.hippoRoot`, where it throws. The store path never reads `hippoRoot`.
 *  `local` runs an option that needs hippo.db's own handle, and refuses it on a served store. */
export function onStore<C extends Context, R>(ctx: C, run: (port: StorePort, local: SqliteLocal) => Reply<R>): StoreReply<C, R> {
  const { store } = ctx;
  // No await before `run`: an add-on relies on the first port call starting inside this call.
  const reply = store ? (async () => run(store, NO_LOCAL))() : run(sqliteSyncStore(ctx.hippoRoot), sqliteLocal(ctx.hippoRoot));
  // SAFETY: the store path is an async function's Promise and hippo.db's port calls answer values, so the Promise comes back exactly when ctx has a store, as StoreReply says.
  return reply as StoreReply<C, R>;
}
