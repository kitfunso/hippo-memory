import type { DatabaseSyncLike } from '../../../db/index.js';
import type { Clock } from '../../../base/ports/infra.js';
import { hostClock } from '../../../host/clock.js';

const clocks = new WeakMap<DatabaseSyncLike, Clock>();
const HOST_CLOCK = hostClock();

/** Ties `db` to the clock of the store handing it to a write; returns `db` for chaining. */
export function bindHandleClock(db: DatabaseSyncLike, clock: Clock): DatabaseSyncLike {
  clocks.set(db, clock);
  return db;
}

/** The instant a write on `db` stamps: its store's clock, else the host's. */
export function handleNow(db: DatabaseSyncLike): Date {
  return (clocks.get(db) ?? HOST_CLOCK)();
}

/** handleNow as the ISO text a row stores. */
export function handleStamp(db: DatabaseSyncLike): string {
  return handleNow(db).toISOString();
}
