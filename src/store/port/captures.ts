// `hippo capture`'s writes: synchronous and hippo.db's own, since each row is mirrored beside the folder and handed to
// the caller's embed callback.
import type { CapturedOutcome, CaptureItem, CaptureWriteOptions } from '../capture-write.js';

export interface Captures {
  /** Each item through the write gate, one outcome per item in order; `keys` holds the texts already stored and gains
   * each one written. */
  write(items: readonly CaptureItem[], keys: Set<string>, opts: CaptureWriteOptions): CapturedOutcome[];
}
