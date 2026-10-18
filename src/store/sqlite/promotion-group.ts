// The built-in store's promotion: the tenant lookup and the promoted-copy write, bound to this store.

import { writePromotedEntry } from '../entry-writes.js';
import type { Promotion } from '../port/promotion.js';
import { memoryReachAt } from '../tenant-lookup.js';
import { type Handles } from '../open.js';

export function sqlitePromotion({ on, files }: Handles): Promotion {
  return {
    reach: (id) => on((db) => memoryReachAt(db, id)),
    writeCopy: (copy, opts) => writePromotedEntry(files.hippoRoot, copy, opts),
  };
}
