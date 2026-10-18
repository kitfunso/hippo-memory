// The Rejections group, kept apart from port.ts: the tombstones `hippo reject` writes and every write guard reads.
import type { MemoryEntry } from '../../core/memory.js';

export interface RejectionCheck {
  readonly tenantId: string;
  readonly entryId: string;
  readonly content: string;
}

export interface Rejections {
  /** In one transaction: the tombstone, the removal of every row in reach holding the text, one reject_value row. */
  apply(rejection: Rejection): Promise<AppliedRejection>;
  /** Lifts the tenant's one tombstone `digestPrefix` names, with its unreject_value row; none or two write nothing. */
  lift(tenantId: string, digestPrefix: string, actor: string): Promise<LiftedRejection>;
  list(tenantId: string): Promise<RejectedValueRow[]>;
  /** Whether a write guard would refuse each check, in order; writes nothing, so a dry run counts what a run skips. */
  refusedAmong(checks: readonly RejectionCheck[]): Promise<boolean[]>;
}

export interface RejectedValueRow {
  tenantId: string;
  digest: string;
  reason: string | null;
  rejectedBy: string | null;
  rejectedAt: string;
  sourceMemoryId: string | null;
  normalizedChars: number | null;
}

export type HoldsValue = (text: string) => boolean;

/** The text, tenant and scope of the memory a rejection names. */
export interface RejectionSource {
  content: string;
  tenant_id: string;
  scope: string | null;
}

/** One rejection as the store applies it. The three functions are the caller's policy over plain rows; none is handed
 * the handle. */
export interface Rejection {
  readonly tenantId: string;
  readonly actor: string;
  readonly reason: string;
  /** The memory whose row `textOf` is given; unset when the caller supplies the text itself. */
  readonly memoryId?: string;
  /** The text to reject. `source` is undefined when `memoryId` is unset or names no row; a throw refuses before any
   * write. */
  readonly textOf: (source: RejectionSource | undefined) => string;
  /** False for a row this caller may not remove. */
  readonly inReach: (scope: string | null | undefined) => boolean;
  /** What replaces a merged row once the rejected text leaves it: undefined when it holds none, null when nothing else
   * is left. */
  readonly successorOf: (
    row: MemoryEntry,
    holdsValue: HoldsValue,
    removedIds: ReadonlySet<string>,
  ) => MemoryEntry | null | undefined;
}

export interface AppliedRejection {
  digest: string;
  /** The rejected text: the stored row keeps only its digest, so no later read can return it. */
  content: string;
  /** Every row removed, live or dormant: each whose digest matched, duplicates included, and each sleep-merged row
   * holding the text. */
  removedIds: string[];
  /** The removedIds of kind 'raw', archived instead of deleted. */
  removedRawIds: string[];
  /** The rows that carry a live merged row's other texts; dormantSuccessorIds is the same for a dormant one. */
  successorIds: string[];
  dormantSuccessorIds: string[];
}

export type LiftedRejection =
  | { status: 'ok'; digest: string; reason: string | null }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: RejectedValueRow[] };
