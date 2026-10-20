// `hippo capture`'s reads and writes: each row is mirrored beside the folder, and the caller embeds what was captured.
import type { HeldText } from './types.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { TenantId } from '../../base/util/tenant.js';

export interface Captures {
  /** Each entry stamped, through the write gate and mirrored, in order on one handle; one outcome per entry. The caller
   * leaves out texts the store already holds and repeats within the batch. */
  write(entries: readonly MemoryEntry[], opts: CaptureWriteOptions): Promise<CapturedOutcome[]>;
  /** The rows holding any of `words`, for the dedup before a write; a row equal to a text apart from spacing holds its
   * every word. `project` keeps rows carrying one of those names plus user-global rows, `everyScope` lifts the
   * team-visible filter for a reader that sees the whole store. */
  textsHolding(
    tenantId: TenantId,
    words: readonly string[],
    opts?: { readonly project?: readonly string[]; readonly everyScope?: boolean },
  ): Promise<HeldText[]>;
}

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureWriteOptions {
  readonly actor?: string;
  /** No stats, as in a server process. */
  readonly lean: boolean;
}
