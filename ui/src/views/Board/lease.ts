import type { Card } from "../../types.js";

/** A running card's lease is expired past leaseUntil, or with no lease at all (CONTEXT.md "Lease"). */
export function isLeaseExpired(card: Card, now: number): boolean {
  return card.leaseUntil === null || Date.parse(card.leaseUntil) < now;
}
