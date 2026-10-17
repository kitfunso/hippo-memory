// `hippo capture`'s reads and writes: synchronous and hippo.db's own, since each row is mirrored beside the folder and
// handed to the caller's embed callback.
import type { CapturedOutcome, CaptureItem, CaptureWriteOptions } from '../capture-write.js';
import type { HeldText } from './types.js';

export interface Captures {
  /** Each item through the write gate, one outcome per item in order; `keys` holds the texts already stored and gains
   * each one written. */
  write(items: readonly CaptureItem[], keys: Set<string>, opts: CaptureWriteOptions): CapturedOutcome[];
  /** The rows holding any of `words`, for the dedup before a write; a row equal to a text apart from spacing holds its
   * every word. `project` keeps rows carrying one of those names plus user-global rows, `everyScope` lifts the
   * team-visible filter for a reader that sees the whole store, and no `tenantId` reads every tenant. */
  textsHolding(
    tenantId: string | undefined,
    words: readonly string[],
    opts?: { readonly project?: readonly string[]; readonly everyScope?: boolean },
  ): HeldText[];
}
