// `hippo capture`'s reads and writes: synchronous and hippo.db's own, since each row is mirrored beside the folder and
// handed to the caller's embed callback.
import type { HeldText } from '../port/types.js';
import type { MemoryEntry } from '../../core/memory.js';
import type { TenantId } from '../../util/tenant.js';

export interface Captures {
  /** Each item through the write gate, one outcome per item in order; `keys` holds the texts already stored and gains
   * each one written. */
  write(items: readonly CaptureItem[], keys: Set<string>, opts: CaptureWriteOptions): CapturedOutcome[];
  /** The rows holding any of `words`, for the dedup before a write; a row equal to a text apart from spacing holds its
   * every word. `project` keeps rows carrying one of those names plus user-global rows, `everyScope` lifts the
   * team-visible filter for a reader that sees the whole store. */
  textsHolding(
    tenantId: TenantId,
    words: readonly string[],
    opts?: { readonly project?: readonly string[]; readonly everyScope?: boolean },
  ): HeldText[];
}

export type CapturedOutcome = 'captured' | 'skipped' | 'rejected';

export interface CaptureItem {
  readonly content: string;
  /** Built only for an item that is not a repeat of an earlier one, since building can throw. */
  readonly makeEntry: () => MemoryEntry;
}

export interface CaptureWriteOptions {
  readonly actor?: string;
  /** No stats, as in a server process. */
  readonly lean: boolean;
  /** Called with each captured entry after its write, so the caller can embed it; the store never picks a provider. */
  readonly onCaptured?: (entry: MemoryEntry) => void;
}
