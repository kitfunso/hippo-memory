import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import type { DeliveryClaim } from '../../../base/ports/store/connectors.js';
import { cachedStatement } from '../../../db/statement-cache.js';

const HOLD = 'delivery_hold:';
const HOLD_END = 'delivery_hold;';

const holdKey = (connector: string, key: string): string => `${HOLD}${connector}:${key}`;

/** True when the key was free and is held now; false when a hold on it has not run out. */
export function claimDelivery(
  db: DatabaseSyncLike,
  { connector, key, nowMs, ttlMs }: DeliveryClaim,
): boolean {
  return withWriteScope(db, 'claim_delivery', () => {
    cachedStatement(
      db,
      `DELETE FROM meta WHERE key >= ? AND key < ? AND CAST(value AS INTEGER) <= ?`,
    ).run(HOLD, HOLD_END, nowMs);
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
