// `hippo capture`'s reads and writes: each row is mirrored beside the folder, and the caller embeds what was captured.
import type { HeldText } from './types.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { TenantId } from '../../base/util/tenant.js';

export interface Captures {
  /** Each entry stamped, through the write gate and mirrored, in order in one transaction; one outcome per entry. The
   * caller leaves out texts its dedup read found and repeats within the batch; the write reads `opts.dedup` again in
   * its transaction and skips an entry whose text a row holds by then, so two captures never store one text twice. */
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
  /** The rows the caller's dedup read: textsHolding's tenant and filter. */
  readonly dedup: CaptureDedup;
}

/** Which rows count as holding a capture's text, as `textsHolding` takes them. */
export interface CaptureDedup {
  readonly tenantId: TenantId;
  readonly project?: readonly string[];
  readonly everyScope?: boolean;
}
