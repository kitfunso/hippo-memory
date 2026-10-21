// The dormant-memory shapes the Dormant group takes and returns.
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { DormantRevival } from '../../base/memory/dormant-revival.js';

/** A dormant memory as listed to a user. */
export interface DormantMemory {
  id: string;
  tenantId: string;
  content: string;
  tags: string[];
  /** Live strength when it went dormant. */
  strength: number;
  /** Why it went dormant: one of the `DormantReason` values. */
  reason: string;
  /** ISO time it went dormant. */
  dormantAt: string;
}

/** Options for `listDormantRows`. */
export interface ListDormantOpts {
  /** Whitespace-separated terms; a row must contain every term (case-insensitive substring). */
  query?: string;
  /** Maximum rows returned, newest first; dormantListCap reads it. */
  limit?: number;
}

/** The query's terms, each a substring a listed row must hold. */
export const dormantTerms = (opts: ListDormantOpts): string[] =>
  (opts.query ?? '')
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 0);

/** The rows a dormant list reads: a whole positive `limit`, else 20. */
export const dormantListCap = ({ limit }: ListDormantOpts): number =>
  limit !== undefined && Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 20;

/** The restored memory, or why nothing was written: no dormant copy in reach, or a live memory already holds the id. */
export type DormantRestoreOutcome =
  | { readonly status: 'restored'; readonly entry: MemoryEntry }
  | { readonly status: 'missing' }
  | { readonly status: 'active' };

export interface DormantRestoreRequest {
  readonly id: string;
  readonly actor: string;
  /** The caller's personal scope: another person's personal row reads as missing. */
  readonly ownScope: string | null;
  /** How the revived row is scored, inside the store's write. */
  readonly revival: DormantRevival;
}

/** `ownScope` is the caller's personal scope; the store builds its own scope test, so no predicate crosses the port. */
export interface Dormant {
  list(tenantId: string, ownScope: string | null, opts: ListDormantOpts): Promise<DormantMemory[]>;
  holds(tenantId: string, ownScope: string | null, id: string): Promise<boolean>;
  /** Revives inside the store's write, so a refused row changes nothing; its entry's origin is filled as writeEntry
   * fills one. */
  restore(tenantId: string, request: DormantRestoreRequest): Promise<DormantRestoreOutcome>;
  /** Deletes for good, writes the `forget` audit row and counts it; false when no row in reach. */
  forget(tenantId: string, ownScope: string | null, id: string, actor: string): Promise<boolean>;
}
