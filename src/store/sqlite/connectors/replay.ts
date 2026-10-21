// Signed deliveries already taken, one meta row each holding its expiry in epoch ms, so a restart or a second process
// still refuses a captured request. Every claim sweeps the expired rows first, as a server can run for months.
import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { DeliveryClaim } from '../../port/connectors.js';
import { cachedStatement } from '../../../db/statement-cache.js';

const HOLD = 'delivery_hold:';
// The first key past every hold key, as ';' follows ':'.
const HOLD_END = 'delivery_hold;';

const holdKey = (connector: string, key: string): string => `${HOLD}${connector}:${key}`;

/** True when the key was free and is held now; false when a hold on it has not run out. */
export function claimDelivery(db: DatabaseSyncLike, { connector, key, nowMs, ttlMs }: DeliveryClaim): boolean {
  return withWriteScope(db, 'claim_delivery', () => {
    cachedStatement(db, `DELETE FROM meta WHERE key >= ? AND key < ? AND CAST(value AS INTEGER) <= ?`).run(
      HOLD,
      HOLD_END,
      nowMs,
    );
    const taken = cachedStatement(db, `INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`).run(
      holdKey(connector, key),
      String(nowMs + ttlMs),
    );
    return Number(taken.changes ?? 0) !== 0;
  });
}

export function releaseDelivery(db: DatabaseSyncLike, connector: string, key: string): void {
  cachedStatement(db, `DELETE FROM meta WHERE key = ?`).run(holdKey(connector, key));
}
