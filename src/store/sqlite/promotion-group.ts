// The built-in store's promotion: the promoted-copy write, bound to this store.

import { writePromotedEntry } from '../entry-writes.js';
import type { Promotion } from '../port/promotion.js';
import { type Handles } from '../open.js';

export function sqlitePromotion({ files }: Handles): Promotion {
  return {
    writeCopy: async (copy, opts) => writePromotedEntry(files.hippoRoot, copy, opts),
  };
}
