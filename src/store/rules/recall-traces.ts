// How long the delivery ledger and the recall traces stay, once for both adapters.
import { DAY_MS } from '../../base/util/time.js';

/** Delivery events, and recall traces with no outcome that are not the store's last recall, are kept this long. */
const RETENTION_DAYS = 90;

/** The stamp a prune deletes rows before, counted back from the write's `ts` capped at the real clock, so a far-future
 * fake time spares real rows. */
export const deliveryCutoff = (ts: string, nowMs: number): string =>
  new Date(Math.min(Date.parse(ts), nowMs) - RETENTION_DAYS * DAY_MS).toISOString();
