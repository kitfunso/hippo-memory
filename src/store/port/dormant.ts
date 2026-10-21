// The dormant-memory shapes the Dormant group takes and returns.
import type { MemoryEntry } from '../../base/memory/memory.js';

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
